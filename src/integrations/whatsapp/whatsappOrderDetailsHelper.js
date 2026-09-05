'use strict';

/**
 * Build Meta Cloud API `interactive.type = order_details` payloads from a CommerceOrder.
 *
 * India payments: Meta does NOT accept a raw UPI VPA in the message. You must link
 * Razorpay/PayU in WhatsApp Business Manager and pass `configuration_name` here.
 * The customer then picks UPI / WhatsApp Pay inside Meta's Review & Pay screen.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/payments-api
 */

const OFFSET = 100;

/** Convert major currency units (e.g. 150.50 INR) to minor units for Meta (paise). */
function toMinor(amount) {
  const n = Number(amount);
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.round(n * OFFSET);
}

function amountObj(minor) {
  return { value: Math.max(0, Math.round(minor)), offset: OFFSET };
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
 * Meta India: online/UPI both use payment_gateway + configuration from Business Manager.
 * @returns {Array<object>|null}
 */
function buildPaymentSettings(method, opts = {}) {
  if (method === 'cod') return null;
  if (method === 'upi' || method === 'razorpay' || method === 'card' || method === 'online') {
    const configurationName = String(opts.configurationName || 'default').trim();
    if (!configurationName) return null;
    return [{
      type: 'payment_gateway',
      payment_gateway: {
        type: String(opts.gatewayType || 'razorpay'),
        configuration_name: configurationName
      }
    }];
  }
  return null;
}

/** Required for physical-goods orders — built from saved shipping on the order. */
function buildBeneficiaries(order) {
  const ship = order.shipping || {};
  const raw = order.shippingAddress || ship.line1 || '';
  const pin = ship.pincode || (String(raw).match(/\b(\d{6})\b/) || [])[1] || '';
  const line1 = (ship.line1 || raw || 'Delivery address').slice(0, 100);
  return [{
    name: (ship.name || order.buyerName || 'Customer').slice(0, 200),
    address_line1: line1,
    address_line2: (ship.line2 || '').slice(0, 100),
    city: (ship.city || '').slice(0, 100),
    state: (ship.state || '').slice(0, 100),
    country: 'India',
    postal_code: /^\d{6}$/.test(pin) ? pin : '110001'
  }];
}

/**
 * Build the full interactive order_details object for the Messages API.
 */
function buildOrderDetailsInteractive(order, opts = {}) {
  const lineItems = order.lineItems || [];
  const currency = 'INR';
  const subtotalMajor = lineItems.reduce(
    (s, li) => s + (Number(li.unitPrice) || 0) * (Number(li.qty) || 1),
    order.totalAmount != null ? Number(order.totalAmount) : 0
  );
  const taxMinor = 0;
  const shippingMinor = 0;
  const discountMinor = 0;
  const subtotalMinor = toMinor(subtotalMajor);
  const totalMinor = subtotalMinor + taxMinor + shippingMinor - discountMinor;

  const importerName = (opts.importerName || 'Seller').slice(0, 200);
  const importerAddress = (opts.importerAddress || 'India').slice(0, 200);

  const items = lineItems.map((li) => {
    const unit = Number(li.unitPrice) || 0;
    const row = {
      retailer_id: String(li.retailerId || li.product || li.name || 'item').slice(0, 100),
      name: String(li.name || 'Item').slice(0, 60),
      amount: amountObj(toMinor(unit)),
      quantity: Math.max(1, Number(li.qty) || 1)
    };
    if (!opts.catalogId) {
      row.country_of_origin = 'India';
      row.importer_name = importerName;
      row.importer_address = importerAddress;
    }
    return row;
  });

  if (!items.length) {
    const fallback = {
      retailer_id: String(order.displayRef || 'order').slice(0, 100),
      name: `Order ${order.displayRef || ''}`.trim().slice(0, 60),
      amount: amountObj(totalMinor),
      quantity: 1
    };
    if (!opts.catalogId) {
      fallback.country_of_origin = 'India';
      fallback.importer_name = importerName;
      fallback.importer_address = importerAddress;
    }
    items.push(fallback);
  }

  const paymentSettings = buildPaymentSettings(opts.paymentMethod, opts);
  const referenceId = String(opts.referenceId || order.displayRef || order._id || Date.now())
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 35);

  const parameters = {
    reference_id: referenceId,
    type: opts.goodsType === 'digital-goods' ? 'digital-goods' : 'physical-goods',
    currency,
    total_amount: amountObj(totalMinor),
    order: {
      status: 'pending',
      items,
      subtotal: amountObj(subtotalMinor),
      tax: { ...amountObj(taxMinor), description: 'Tax' },
      shipping: { ...amountObj(shippingMinor), description: 'Shipping' },
      discount: {
        ...amountObj(discountMinor),
        description: 'Discount',
        discount_program_name: 'Discount'
      }
    }
  };

  if (opts.catalogId) parameters.order.catalog_id = String(opts.catalogId);

  if (parameters.type === 'physical-goods') {
    parameters.beneficiaries = buildBeneficiaries(order);
  }

  if (paymentSettings?.length) {
    parameters.payment_settings = paymentSettings;
  }

  const interactive = {
    type: 'order_details',
    body: { text: String(opts.bodyText || 'Review your order details below.').slice(0, 1024) },
    action: {
      name: 'review_and_pay',
      parameters
    }
  };

  if (opts.headerText) {
    interactive.header = { type: 'text', text: String(opts.headerText).slice(0, 60) };
  }
  if (opts.footerText) {
    interactive.footer = { text: String(opts.footerText).slice(0, 60) };
  }

  return interactive;
}

/** Plain-text fallback when COD is chosen or Meta payments API rejects / is not configured. */
function buildOrderSummaryText(order, opts = {}) {
  const ref = order.displayRef || '';
  const items = (order.lineItems || [])
    .map((li) => `• ${li.qty || 1}× ${li.name || 'item'}`)
    .join('\n');
  const total = order.totalAmount != null ? `${order.currency || 'INR'} ${order.totalAmount}` : '';
  const pay = opts.paymentMethodLabel ? `\n💳 Payment: ${opts.paymentMethodLabel}` : '';
  const addr = opts.deliveryAddress ? `\n📦 Deliver to:\n${opts.deliveryAddress}` : '';
  const payNote = opts.paymentNote ? `\n\n${opts.paymentNote}` : '';
  return (
    `🧾 *Order ${ref}*\n\n`
    + (items ? `${items}\n\n` : '')
    + (total ? `*Total:* ${total}` : '')
    + pay
    + addr
    + payNote
    + '\n\nThank you! We’ll confirm once payment is received.'
  );
}

module.exports = {
  buildOrderDetailsInteractive,
  buildOrderSummaryText,
  buildPaymentSettings,
  buildBeneficiaries,
  resolvePaymentMethod,
  paymentLabel,
  toMinor
};
