'use strict';

/**
 * Build Meta Cloud API `interactive.type = order_details` payloads from a CommerceOrder.
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/payments-api/payments-in/checkout-button-templates
 */

const OFFSET = 100;

/** Convert major currency units (e.g. 150.50 INR) to minor units for Meta (paise). */
function toMinor(amount) {
  const n = Number(amount);
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.round(n * OFFSET);
}

function amountObj(major) {
  return { value: toMinor(major), offset: OFFSET };
}

const PAYMENT_METHOD_LABELS = {
  cod: 'Cash on Delivery',
  upi: 'UPI',
  razorpay: 'Online payment',
  card: 'Card / online payment',
  online: 'Online payment'
};

/** Map WhatsApp button/list ids or free-text replies to internal payment method codes. */
function resolvePaymentMethod({ buttonPayload, text, explicit }) {
  if (explicit) return String(explicit).toLowerCase();
  const id = String(buttonPayload || '').toLowerCase();
  if (id === 'pay_cod' || id.includes('cod')) return 'cod';
  if (id === 'pay_upi' || id.includes('upi')) return 'upi';
  if (id === 'pay_online' || id === 'pay_card' || id.includes('online') || id.includes('card')) {
    return 'razorpay';
  }
  const t = String(text || '').toLowerCase();
  if (/\bcod\b|cash on delivery|cash/.test(t)) return 'cod';
  if (/\bupi\b|gpay|phonepe|paytm/.test(t)) return 'upi';
  if (/online|card|razorpay|pay now/.test(t)) return 'razorpay';
  return '';
}

function paymentLabel(method) {
  return PAYMENT_METHOD_LABELS[method] || method || '';
}

/**
 * Build payment_settings array for Meta order_details from node/org config.
 * @param {string} method  cod | upi | razorpay
 * @param {object} opts
 * @param {string} [opts.upiVpa]
 * @param {string} [opts.gatewayType]
 * @param {string} [opts.configurationName]
 * @returns {Array<object>|null}
 */
function buildPaymentSettings(method, opts = {}) {
  if (method === 'cod') return null;
  if (method === 'upi') {
    const vpa = String(opts.upiVpa || '').trim();
    if (!vpa) return null;
    return [{ type: 'upi', upi: { vpa, purpose_code: '00' } }];
  }
  if (method === 'razorpay' || method === 'card' || method === 'online') {
    return [{
      type: 'payment_gateway',
      payment_gateway: {
        type: String(opts.gatewayType || 'razorpay'),
        configuration_name: String(opts.configurationName || 'default')
      }
    }];
  }
  return null;
}

/**
 * Build the full interactive order_details object for the Messages API.
 * @param {object} order         CommerceOrder doc or lean object
 * @param {object} opts
 * @param {string} opts.bodyText
 * @param {string} [opts.headerText]
 * @param {string} [opts.footerText]
 * @param {string} [opts.catalogId]
 * @param {string} [opts.goodsType]  physical-goods | digital-goods
 * @param {string} [opts.paymentMethod]
 * @param {string} [opts.upiVpa]
 * @param {string} [opts.gatewayType]
 * @param {string} [opts.configurationName]
 * @param {string} [opts.referenceId]
 */
function buildOrderDetailsInteractive(order, opts = {}) {
  const lineItems = order.lineItems || [];
  const currency = String(order.currency || 'INR').toUpperCase();
  const totalMajor = order.totalAmount != null
    ? Number(order.totalAmount)
    : lineItems.reduce((s, li) => s + (Number(li.unitPrice) || 0) * (Number(li.qty) || 1), 0);

  const items = lineItems.map((li) => {
    const unit = Number(li.unitPrice) || 0;
    return {
      retailer_id: String(li.retailerId || li.product || li.name || 'item'),
      name: String(li.name || 'Item').slice(0, 100),
      amount: amountObj(unit),
      quantity: Math.max(1, Number(li.qty) || 1)
    };
  });

  if (!items.length) {
    items.push({
      retailer_id: order.displayRef || 'order',
      name: `Order ${order.displayRef || ''}`.trim(),
      amount: amountObj(totalMajor),
      quantity: 1
    });
  }

  const subtotalMajor = lineItems.reduce(
    (s, li) => s + (Number(li.unitPrice) || 0) * (Number(li.qty) || 1),
    totalMajor
  );

  const paymentSettings = buildPaymentSettings(opts.paymentMethod, opts);
  const referenceId = String(opts.referenceId || order.displayRef || order._id || Date.now()).slice(0, 35);

  const parameters = {
    reference_id: referenceId,
    type: opts.goodsType === 'digital-goods' ? 'digital-goods' : 'physical-goods',
    currency,
    total_amount: amountObj(totalMajor),
    order: {
      status: 'pending',
      items
    }
  };

  if (opts.catalogId) parameters.order.catalog_id = String(opts.catalogId);
  parameters.order.subtotal = amountObj(subtotalMajor);
  parameters.order.tax = { value: 0, offset: OFFSET, description: 'Tax' };
  parameters.order.shipping = { value: 0, offset: OFFSET, description: 'Shipping' };
  parameters.order.discount = { value: 0, offset: OFFSET, description: 'Discount', program_name: 'Discount' };

  if (paymentSettings?.length) {
    parameters.payment_settings = paymentSettings;
    parameters.payment_type = opts.paymentMethod === 'upi' ? 'upi' : 'payment_gateway';
  }

  const interactive = {
    type: 'order_details',
    body: { text: String(opts.bodyText || 'Review your order details below.') },
    action: {
      name: 'review_and_pay',
      parameters
    }
  };

  if (opts.headerText) interactive.header = { type: 'text', text: String(opts.headerText).slice(0, 60) };
  if (opts.footerText) interactive.footer = { text: String(opts.footerText).slice(0, 60) };

  return interactive;
}

/** Plain-text fallback when COD is chosen or Meta payments are not configured. */
function buildOrderSummaryText(order, opts = {}) {
  const ref = order.displayRef || '';
  const items = (order.lineItems || [])
    .map((li) => `• ${li.qty || 1}× ${li.name || 'item'}`)
    .join('\n');
  const total = order.totalAmount != null ? `${order.currency || 'INR'} ${order.totalAmount}` : '';
  const pay = opts.paymentMethodLabel ? `\n💳 Payment: ${opts.paymentMethodLabel}` : '';
  const addr = opts.deliveryAddress ? `\n📦 Deliver to:\n${opts.deliveryAddress}` : '';
  return (
    `🧾 *Order ${ref}*\n\n`
    + (items ? `${items}\n\n` : '')
    + (total ? `*Total:* ${total}` : '')
    + pay
    + addr
    + '\n\nThank you! We’ll confirm once payment is received.'
  );
}

module.exports = {
  buildOrderDetailsInteractive,
  buildOrderSummaryText,
  buildPaymentSettings,
  resolvePaymentMethod,
  paymentLabel,
  toMinor
};
