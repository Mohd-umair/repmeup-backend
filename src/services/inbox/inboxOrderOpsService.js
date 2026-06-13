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
  intent: ['product_sent', 'cancelled'],
  product_sent: ['cart_started', 'payment_pending', 'cancelled'],
  cart_started: ['payment_pending', 'cancelled'],
  payment_pending: ['paid', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  shipped: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: []
};

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

  if (tab === 'paid') filter.status = 'paid';
  else if (tab === 'payment_pending') filter.status = 'payment_pending';
  else if (tab === 'shipped') filter.status = 'shipped';
  else if (tab === 'delivered') filter.status = 'delivered';
  else if (tab === 'cancelled') filter.status = 'cancelled';
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
  const events = [];
  const push = (event, at, pending = false) => {
    if (at || pending) events.push({ event, at: at || null, atLabel: at ? formatDateLabel(at) : 'Pending', pending });
  };
  push(`Order placed via ${CHANNEL_LABELS[order.channel] || order.channel}`, order.createdAt);
  if (order.paidAt) push('Payment confirmed', order.paidAt);
  if (order.shippedAt) push('Order shipped', order.shippedAt);
  if (order.deliveredAt) push('Order delivered', order.deliveredAt);
  if (order.status === 'cancelled') push('Order cancelled', order.updatedAt);
  if (order.status === 'paid' && !order.shippedAt) push('Awaiting warehouse processing', null, true);
  if (order.status === 'shipped' && !order.deliveredAt) push('Awaiting delivery confirmation', null, true);
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
          { $match: { status: { $in: ['paid', 'shipped', 'delivered'] } } },
          { $group: { _id: null, total: { $sum: { $ifNull: ['$totalAmount', 0] } } } }
        ],
        pendingPayment: [{ $match: { status: 'payment_pending' } }, { $count: 'n' }],
        shippedToday: [
          { $match: { status: 'shipped', shippedAt: { $gte: todayStart } } },
          { $count: 'n' }
        ]
      }
    }
  ]);

  const pick = (arr) => arr?.[0]?.n ?? arr?.[0]?.total ?? 0;
  const today = pick(facet.todayOrders);
  const yesterday = pick(facet.yesterdayOrders);
  const deltaPct = yesterday > 0 ? Math.round(((today - yesterday) / yesterday) * 100) : today > 0 ? 100 : 0;

  return {
    totalOrders: pick(facet.totalOrders),
    revenueClosed: pick(facet.revenueClosed),
    pendingPayment: pick(facet.pendingPayment),
    shippedToday: pick(facet.shippedToday),
    ordersToday: today,
    deltaVsYesterdayPct: deltaPct
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
    shippingAddress: order.shippingAddress || '—',
    tracking: order.notes?.includes('tracking') ? order.notes : 'Not yet assigned',
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

async function updateOrderStatus(orgId, orderId, status, notes) {
  const order = await CommerceOrder.findOne({ _id: orderId, organization: orgId });
  if (!order) return { error: 'not_found' };

  const allowed = VALID_STATUS_TRANSITIONS[order.status] || [];
  if (!allowed.includes(status)) {
    return { error: `Cannot transition from '${order.status}' to '${status}'` };
  }

  order.status = status;
  if (notes) order.notes = notes;
  if (status === 'paid') order.paidAt = new Date();
  if (status === 'shipped') order.shippedAt = new Date();
  if (status === 'delivered') order.deliveredAt = new Date();
  await order.save();

  return { order: await getOrderDetail(orgId, orderId) };
}

async function createOrder(orgId, body) {
  const { channel = 'manual', lineItems = [], buyerName, buyerPhone, shippingAddress, notes } = body;

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

  const payload = await assignOrderDisplayRef(orgId, {
    organization: orgId,
    channel,
    status: 'payment_pending',
    lineItems: builtItems,
    totalAmount,
    currency: builtItems[0]?.currency || 'INR',
    buyerName: buyerName?.trim() || undefined,
    buyerPhone: buyerPhone?.trim() || undefined,
    shippingAddress: shippingAddress?.trim() || undefined,
    notes: notes?.trim() || undefined
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
  createOrder,
  VALID_STATUS_TRANSITIONS,
  buildListFilter,
  mapOrderRow
};
