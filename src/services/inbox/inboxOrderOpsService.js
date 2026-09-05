'use strict';

const CommerceOrder = require('../../models/CommerceOrder');
const Product = require('../../models/Product');
const { assignOrderDisplayRef } = require('../../utils/opsRefHelper');
const {
  CHANNEL_LABELS,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_TONE,
  formatMoney,
  formatDateLabel,
  customerFromOrder,
  lineItemsSummary,
  paymentLabelForOrder,
  chatDeepLink
} = require('./inboxOpsFormatters');

const VALID_STATUS_TRANSITIONS = {
  pending:          ['confirmed', 'payment_pending', 'paid', 'cancelled'],
  confirmed:        ['payment_pending', 'paid', 'processing', 'cancelled'],
  payment_pending:  ['paid', 'cancelled'],
  paid:             ['processing', 'dispatched', 'cancelled'],
  processing:       ['dispatched', 'cancelled'],
  dispatched:       ['out_for_delivery', 'delivered', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
  delivered:        ['returned'],
  returned:         ['refunded'],
  refunded:         [],
  cancelled:        [],
  // legacy entry points route into the canonical flow
  intent:           ['confirmed', 'payment_pending', 'paid', 'cancelled'],
  product_sent:     ['confirmed', 'payment_pending', 'paid', 'cancelled'],
  cart_started:     ['confirmed', 'payment_pending', 'paid', 'cancelled'],
  shipped:          ['out_for_delivery', 'delivered', 'cancelled']
};

/** status → the timestamp field stamped when an order enters it. */
const STATUS_TIMESTAMP = {
  confirmed: 'confirmedAt',
  paid: 'paidAt',
  processing: 'processingAt',
  dispatched: 'dispatchedAt',
  shipped: 'shippedAt',
  out_for_delivery: 'outForDeliveryAt',
  delivered: 'deliveredAt',
  cancelled: 'cancelledAt',
  returned: 'returnedAt',
  refunded: 'refundedAt'
};

/** List tabs → the underlying statuses they include. */
const TAB_STATUS = {
  pending: ['pending', 'intent', 'product_sent', 'cart_started', 'confirmed'],
  payment_pending: ['payment_pending'],
  paid: ['paid'],
  processing: ['processing'],
  dispatched: ['dispatched', 'shipped', 'out_for_delivery'],
  delivered: ['delivered'],
  cancelled: ['cancelled'],
  returns: ['returned', 'refunded']
};

const REVENUE_STATUSES = ['paid', 'processing', 'dispatched', 'shipped', 'out_for_delivery', 'delivered'];

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfYesterday() {
  const d = startOfToday();
  d.setDate(d.getDate() - 1);
  return d;
}

function buildListFilter(orgId, query) {
  const filter = { organization: orgId };
  const { status, channel, search, from, to, tab } = query;

  if (tab && tab !== 'all' && TAB_STATUS[tab]) filter.status = { $in: TAB_STATUS[tab] };
  else if (status) filter.status = status;

  if (channel) filter.channel = channel;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  if (search) {
    filter.$or = [
      { displayRef: { $regex: search, $options: 'i' } },
      { buyerName: { $regex: search, $options: 'i' } },
      { buyerPhone: { $regex: search, $options: 'i' } },
      { metaOrderId: { $regex: search, $options: 'i' } }
    ];
  }
  return filter;
}

function mapOrderRow(order) {
  const payment = paymentLabelForOrder(order);
  const interactionId = order.sourceInteraction?._id?.toString?.() || order.sourceInteraction?.toString?.() || null;
  const customer = customerFromOrder(order);
  return {
    id: order._id.toString(),
    displayRef: order.displayRef || order._id.toString().slice(-8).toUpperCase(),
    customerName: customer.name,
    customerHandle: customer.handle,
    channel: order.channel,
    channelLabel: CHANNEL_LABELS[order.channel] || order.channel,
    itemsSummary: lineItemsSummary(order.lineItems),
    amountFormatted: formatMoney(order.totalAmount, order.currency),
    paymentLabel: payment.label,
    paymentTone: payment.tone,
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status] || order.status,
    statusTone: ORDER_STATUS_TONE[order.status] || 'neutral',
    createdAt: order.createdAt,
    createdAtLabel: formatDateLabel(order.createdAt),
    sourceInteractionId: interactionId,
    chatDeepLink: chatDeepLink(interactionId)
  };
}

function buildTimeline(order) {
  const events = [{
    event: `Order placed via ${CHANNEL_LABELS[order.channel] || order.channel}`,
    at: order.createdAt,
    atLabel: formatDateLabel(order.createdAt),
    pending: false
  }];

  if (order.statusHistory && order.statusHistory.length) {
    order.statusHistory.forEach((h) => {
      const label = ORDER_STATUS_LABELS[h.status] || h.status;
      events.push({
        event: h.note ? `${label} — ${h.note}` : label,
        at: h.at,
        atLabel: formatDateLabel(h.at),
        pending: false
      });
    });
  } else {
    // Legacy orders (no statusHistory) — derive from lifecycle timestamps.
    const legacy = [
      ['confirmedAt', 'Confirmed'], ['paidAt', 'Payment confirmed'], ['processingAt', 'Processing'],
      ['dispatchedAt', 'Dispatched'], ['shippedAt', 'Dispatched'], ['outForDeliveryAt', 'Out for Delivery'],
      ['deliveredAt', 'Delivered'], ['cancelledAt', 'Cancelled'], ['returnedAt', 'Returned'], ['refundedAt', 'Refunded']
    ];
    legacy.forEach(([f, label]) => {
      if (order[f]) events.push({ event: label, at: order[f], atLabel: formatDateLabel(order[f]), pending: false });
    });
  }

  // Hint at the next forward step (skip terminal/negative transitions).
  const next = (VALID_STATUS_TRANSITIONS[order.status] || [])
    .find((s) => !['cancelled', 'returned', 'refunded'].includes(s));
  if (next) {
    events.push({ event: `Next: ${ORDER_STATUS_LABELS[next] || next}`, at: null, atLabel: 'Pending', pending: true });
  }
  return events;
}

async function listOrders(orgId, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 30));
  const skip = (page - 1) * limit;
  const filter = buildListFilter(orgId, query);

  const [orders, total] = await Promise.all([
    CommerceOrder.find(filter)
      .select('-__v')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('lineItems.product', 'name sku price currency')
      .populate('contact', 'name phone email avatarUrl')
      .populate('sourceInteraction', '_id')
      .lean(),
    CommerceOrder.countDocuments(filter)
  ]);

  return {
    rows: orders.map(mapOrderRow),
    total,
    page,
    limit
  };
}

async function getOrderStats(orgId, query = {}) {
  const todayStart = startOfToday();
  const yesterdayStart = startOfYesterday();
  const match = { organization: orgId };
  if (query.from || query.to) {
    match.createdAt = {};
    if (query.from) match.createdAt.$gte = new Date(query.from);
    if (query.to) match.createdAt.$lte = new Date(query.to);
  }

  const [facet] = await CommerceOrder.aggregate([
    { $match: match },
    {
      $facet: {
        totalOrders: [{ $count: 'n' }],
        todayOrders: [{ $match: { createdAt: { $gte: todayStart } } }, { $count: 'n' }],
        yesterdayOrders: [
          { $match: { createdAt: { $gte: yesterdayStart, $lt: todayStart } } },
          { $count: 'n' }
        ],
        revenueClosed: [
          { $match: { status: { $in: REVENUE_STATUSES } } },
          { $group: { _id: null, total: { $sum: { $ifNull: ['$totalAmount', 0] } } } }
        ],
        pendingPayment: [{ $match: { status: { $in: ['pending', 'payment_pending', 'cart_started', 'confirmed'] } } }, { $count: 'n' }],
        dispatchedToday: [
          { $match: { status: { $in: ['dispatched', 'shipped', 'out_for_delivery'] }, dispatchedAt: { $gte: todayStart } } },
          { $count: 'n' }
        ],
        deliveredCount: [{ $match: { status: 'delivered' } }, { $count: 'n' }],
        byStatus: [{ $group: { _id: '$status', n: { $sum: 1 } } }]
      }
    }
  ]);

  const pick = (arr) => arr?.[0]?.n ?? arr?.[0]?.total ?? 0;
  const today = pick(facet.todayOrders);
  const yesterday = pick(facet.yesterdayOrders);
  const deltaPct = yesterday > 0 ? Math.round(((today - yesterday) / yesterday) * 100) : today > 0 ? 100 : 0;

  // Per-tab counts for the list tab badges.
  const byStatus = {};
  (facet.byStatus || []).forEach((r) => { byStatus[r._id] = r.n; });
  const statusCounts = { all: pick(facet.totalOrders) };
  for (const [tab, statuses] of Object.entries(TAB_STATUS)) {
    statusCounts[tab] = statuses.reduce((sum, s) => sum + (byStatus[s] || 0), 0);
  }

  return {
    totalOrders: pick(facet.totalOrders),
    revenueClosed: pick(facet.revenueClosed),
    pendingPayment: pick(facet.pendingPayment),
    shippedToday: pick(facet.dispatchedToday),
    deliveredCount: pick(facet.deliveredCount),
    ordersToday: today,
    deltaVsYesterdayPct: deltaPct,
    statusCounts
  };
}

async function getOrderDetail(orgId, orderId) {
  const order = await CommerceOrder.findOne({ _id: orderId, organization: orgId })
    .populate('lineItems.product', 'name sku images price currency')
    .populate('contact', 'name phone email avatarUrl tags')
    .populate('sourceInteraction', 'platform type content author replies')
    .lean();

  if (!order) return null;

  const customer = customerFromOrder(order);
  const payment = paymentLabelForOrder(order);
  const interactionId = order.sourceInteraction?._id?.toString?.() || null;
  const interaction = order.sourceInteraction;

  const chatSnippet = [];
  if (interaction?.content) {
    chatSnippet.push({ from: 'customer', text: String(interaction.content).substring(0, 500) });
  }
  const lastReply = interaction?.replies?.length
    ? interaction.replies[interaction.replies.length - 1]
    : null;
  if (lastReply?.content) {
    chatSnippet.push({ from: 'team', text: String(lastReply.content).substring(0, 500) });
  }

  return {
    ...mapOrderRow(order),
    customer,
    payment,
    paymentMethod: order.paymentMethod || null,
    shippingAddress: order.shippingAddress || '—',
    shipping: order.shipping || null,
    tracking: order.tracking || null,
    cancellationReason: order.cancellationReason || null,
    returnReason: order.returnReason || null,
    refund: order.refund?.at
      ? { amount: formatMoney(order.refund.amount, order.currency), reference: order.refund.reference || null, atLabel: formatDateLabel(order.refund.at) }
      : null,
    timeline: buildTimeline(order),
    chatSnippet,
    lineItems: (order.lineItems || []).map((li) => ({
      name: li.name || li.product?.name || 'Item',
      sku: li.product?.sku || li.retailerId || null,
      image: (Array.isArray(li.product?.images) && li.product.images[0]) || null,
      qty: li.qty,
      unitPrice: formatMoney(li.unitPrice, li.currency || order.currency),
      lineTotal: formatMoney((li.unitPrice || 0) * (li.qty || 1), li.currency || order.currency)
    })),
    actions: {
      canMarkShipped: order.status === 'paid',
      canUpdateStatus: (VALID_STATUS_TRANSITIONS[order.status] || []).length > 0,
      nextStatuses: VALID_STATUS_TRANSITIONS[order.status] || []
    },
    totalAmount: order.totalAmount || 0,
    currency: order.currency || 'INR',
    chatDeepLink: chatDeepLink(interactionId)
  };
}

/**
 * Resolve the most recent order linked to an inbox interaction.
 * Powers the "Order placed" chip deep-link from the inbox → Order Management.
 * Returns a lightweight ref (or null) — the page fetches full detail by id.
 */
async function getOrderByInteraction(orgId, interactionId) {
  if (!/^[a-f\d]{24}$/i.test(String(interactionId || ''))) return null;
  const order = await CommerceOrder.findOne({ organization: orgId, sourceInteraction: interactionId })
    .sort({ createdAt: -1 })
    .select('_id displayRef status')
    .lean();
  if (!order) return null;
  return { id: order._id.toString(), displayRef: order.displayRef || null, status: order.status };
}

/**
 * Advance an order through the lifecycle, applying status-specific extras:
 *  - dispatched → extra.tracking { courier, trackingNumber, trackingUrl }
 *  - cancelled / returned → extra.reason
 *  - paid → extra.paymentMethod / extra.paymentRef
 *  - refunded → extra.refund { amount, reference }
 * Stamps the matching timestamp and appends to statusHistory.
 */
async function updateOrderStatus(orgId, orderId, status, extra = {}) {
  const order = await CommerceOrder.findOne({ _id: orderId, organization: orgId });
  if (!order) return { error: 'not_found' };

  const allowed = VALID_STATUS_TRANSITIONS[order.status] || [];
  if (!allowed.includes(status)) {
    return { error: `Cannot transition from '${order.status}' to '${status}'` };
  }

  const now = new Date();
  const trim = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  order.status = status;

  const tsField = STATUS_TIMESTAMP[status];
  if (tsField && !order[tsField]) order[tsField] = now;
  if (status === 'dispatched' && !order.shippedAt) order.shippedAt = now; // legacy mirror

  if (status === 'dispatched' && extra.tracking) {
    order.tracking = {
      courier: trim(extra.tracking.courier),
      trackingNumber: trim(extra.tracking.trackingNumber),
      trackingUrl: trim(extra.tracking.trackingUrl)
    };
  }
  if (status === 'cancelled') order.cancellationReason = trim(extra.reason) || order.cancellationReason;
  if (status === 'returned') order.returnReason = trim(extra.reason) || order.returnReason;
  if (status === 'paid') {
    if (trim(extra.paymentMethod)) order.paymentMethod = trim(extra.paymentMethod);
    if (trim(extra.paymentRef)) order.paymentRef = trim(extra.paymentRef);
  }
  if (status === 'refunded') {
    const amt = extra.refund?.amount != null && extra.refund.amount !== '' ? Number(extra.refund.amount) : order.totalAmount;
    order.refund = { amount: Number.isNaN(amt) ? undefined : amt, reference: trim(extra.refund?.reference), at: now };
  }
  if (trim(extra.note)) order.notes = trim(extra.note);

  order.statusHistory.push({
    status,
    at: now,
    note: trim(extra.reason) || trim(extra.note) || undefined,
    byName: trim(extra.byName) || undefined
  });

  await order.save();

  if (status === 'delivered') {
    const reviewCollectionService = require('../reviewCollectionService');
    const queue = require('../../config/queue').getReviewRequestQueue();
    reviewCollectionService.enqueueRequest(queue, {
      orgId,
      orderId: order._id,
      interactionId: order.interactionId,
      contactId: order.contactId,
      channel: 'whatsapp'
    }).catch(err => console.warn('[inboxOrderOpsService] Failed to enqueue review request', { error: err.message }));
  }

  return { order: await getOrderDetail(orgId, orderId) };
}

/** Edit the structured shipping address + buyer details on an order. */
async function updateOrderShipping(orgId, orderId, body = {}) {
  const order = await CommerceOrder.findOne({ _id: orderId, organization: orgId });
  if (!order) return { error: 'not_found' };

  const s = body.shipping || {};
  const t = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  order.shipping = {
    name: t(s.name), phone: t(s.phone), line1: t(s.line1), line2: t(s.line2),
    city: t(s.city), state: t(s.state), pincode: t(s.pincode), country: t(s.country) || 'India'
  };
  if (body.buyerName !== undefined) order.buyerName = t(body.buyerName);
  if (body.buyerPhone !== undefined) order.buyerPhone = t(body.buyerPhone);

  // Keep the flattened free-text mirror in sync for legacy display.
  const flat = [order.shipping.line1, order.shipping.line2, order.shipping.city, order.shipping.state, order.shipping.pincode, order.shipping.country]
    .filter(Boolean).join(', ');
  if (flat) order.shippingAddress = flat;

  await order.save();
  return { order: await getOrderDetail(orgId, orderId) };
}

async function createOrder(orgId, body) {
  const { channel = 'manual', lineItems = [], buyerName, buyerPhone, shippingAddress, shipping, notes, status, sourceInteraction } = body;

  if (!lineItems.length) {
    return { error: 'At least one product is required' };
  }

  const productIds = lineItems.map((li) => li.productId);
  const products = await Product.find({
    _id: { $in: productIds },
    organization: orgId,
    isActive: true
  }).lean();

  if (!products.length) {
    return { error: 'No matching active products found' };
  }

  const productMap = products.reduce((m, p) => { m[p._id.toString()] = p; return m; }, {});

  const builtItems = lineItems
    .filter((li) => productMap[li.productId])
    .map((li) => {
      const p = productMap[li.productId];
      const unitPrice = p.discountPercent
        ? +(p.price * (1 - p.discountPercent / 100)).toFixed(2)
        : p.price;
      return {
        product: p._id,
        retailerId: p.sku || p._id.toString(),
        name: p.name,
        qty: Math.max(1, parseInt(li.qty, 10) || 1),
        unitPrice,
        currency: p.currency || 'INR'
      };
    });

  const totalAmount = +builtItems.reduce((sum, li) => sum + li.unitPrice * li.qty, 0).toFixed(2);

  const initialStatus = status && VALID_STATUS_TRANSITIONS[status] !== undefined ? status : 'pending';
  const t = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const structured = shipping && typeof shipping === 'object'
    ? {
        name: t(shipping.name), phone: t(shipping.phone), line1: t(shipping.line1), line2: t(shipping.line2),
        city: t(shipping.city), state: t(shipping.state), pincode: t(shipping.pincode), country: t(shipping.country) || 'India'
      }
    : undefined;

  const mongoose = require('mongoose');
  const sourceInteractionId =
    sourceInteraction && mongoose.Types.ObjectId.isValid(String(sourceInteraction))
      ? String(sourceInteraction)
      : undefined;

  const payload = await assignOrderDisplayRef(orgId, {
    organization: orgId,
    channel,
    status: initialStatus,
    lineItems: builtItems,
    totalAmount,
    currency: builtItems[0]?.currency || 'INR',
    buyerName: t(buyerName),
    buyerPhone: t(buyerPhone),
    shippingAddress: t(shippingAddress),
    shipping: structured,
    notes: t(notes),
    ...(sourceInteractionId ? { sourceInteraction: sourceInteractionId } : {}),
    statusHistory: [{ status: initialStatus, at: new Date(), note: 'Order created' }]
  });

  const order = await CommerceOrder.create(payload);
  return { order: await getOrderDetail(orgId, order._id) };
}

module.exports = {
  listOrders,
  getOrderStats,
  getOrderDetail,
  getOrderByInteraction,
  updateOrderStatus,
  updateOrderShipping,
  createOrder,
  VALID_STATUS_TRANSITIONS,
  TAB_STATUS,
  buildListFilter,
  mapOrderRow
};
