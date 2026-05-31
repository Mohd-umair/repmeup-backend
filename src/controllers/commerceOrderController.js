'use strict';

/**
 * Commerce Order Controller
 *
 * CRUD + list operations for CommerceOrder (the unified omnichannel order model).
 * Designed to power the Catalog → Orders tab on the frontend.
 *
 * Routes:
 *   GET    /commerce-orders              — paginated list with filters
 *   GET    /commerce-orders/stats        — summary counts by status / channel
 *   GET    /commerce-orders/:id          — single order (populated)
 *   PATCH  /commerce-orders/:id/status   — update status
 *   POST   /commerce-orders              — manual order creation
 *   DELETE /commerce-orders/:id          — cancel order
 */

const CommerceOrder = require('../models/CommerceOrder');
const Product = require('../models/Product');
const logger = require('../config/logger');
const { assignOrderDisplayRef } = require('../utils/opsRefHelper');

// ── Helper ────────────────────────────────────────────────────────────────────

function orgId(req) {
  return req.user.organization._id;
}

// ── LIST ──────────────────────────────────────────────────────────────────────

exports.listOrders = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 30,
      status,
      channel,
      search,
      from,
      to
    } = req.query;

    const filter = { organization: orgId(req) };
    if (status) filter.status = status;
    if (channel) filter.channel = channel;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }
    if (search) {
      filter.$or = [
        { buyerName: { $regex: search, $options: 'i' } },
        { buyerPhone: { $regex: search, $options: 'i' } },
        { metaOrderId: { $regex: search, $options: 'i' } },
        { orderToken: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [orders, total] = await Promise.all([
      CommerceOrder.find(filter)
        .select('-__v')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate('lineItems.product', 'name sku images price currency')
        .populate('contact', 'name phone email avatarUrl')
        .lean(),
      CommerceOrder.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data: { orders, total, page: Number(page), limit: Number(limit) }
    });
  } catch (err) {
    next(err);
  }
};

// ── STATS ─────────────────────────────────────────────────────────────────────

exports.getOrderStats = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const match = { organization: orgId(req) };
    if (from || to) {
      match.createdAt = {};
      if (from) match.createdAt.$gte = new Date(from);
      if (to) match.createdAt.$lte = new Date(to);
    }

    const [byStatus, byChannel, totalRevenue] = await Promise.all([
      CommerceOrder.aggregate([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      CommerceOrder.aggregate([
        { $match: match },
        { $group: { _id: '$channel', count: { $sum: 1 } } }
      ]),
      CommerceOrder.aggregate([
        { $match: { ...match, status: { $in: ['paid', 'shipped', 'delivered'] } } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } }
      ])
    ]);

    const statusMap = byStatus.reduce((acc, row) => {
      acc[row._id] = row.count;
      return acc;
    }, {});

    const channelMap = byChannel.reduce((acc, row) => {
      acc[row._id] = row.count;
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        byStatus: statusMap,
        byChannel: channelMap,
        totalRevenue: totalRevenue[0]?.total || 0,
        totalOrders: byStatus.reduce((sum, r) => sum + r.count, 0)
      }
    });
  } catch (err) {
    next(err);
  }
};

// ── GET ONE ───────────────────────────────────────────────────────────────────

exports.getOrder = async (req, res, next) => {
  try {
    const order = await CommerceOrder.findOne({
      _id: req.params.id,
      organization: orgId(req)
    })
      .populate('lineItems.product', 'name sku images price currency paymentUrl')
      .populate('contact', 'name phone email avatarUrl tags')
      .populate('sourceInteraction', 'platform type content author')
      .lean();

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    res.json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
};

// ── UPDATE STATUS ─────────────────────────────────────────────────────────────

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

exports.updateOrderStatus = async (req, res, next) => {
  try {
    const { status, notes } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, error: 'status is required' });
    }

    const order = await CommerceOrder.findOne({
      _id: req.params.id,
      organization: orgId(req)
    });
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const allowed = VALID_STATUS_TRANSITIONS[order.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot transition from '${order.status}' to '${status}'`
      });
    }

    order.status = status;
    if (notes) order.notes = notes;
    if (status === 'paid') order.paidAt = new Date();
    if (status === 'shipped') order.shippedAt = new Date();
    if (status === 'delivered') order.deliveredAt = new Date();

    await order.save();
    logger.info('[commerceOrder] status updated', {
      orderId: order._id.toString(),
      status,
      orgId: String(orgId(req))
    });

    res.json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
};

// ── CREATE (manual) ───────────────────────────────────────────────────────────

exports.createOrder = async (req, res, next) => {
  try {
    const {
      channel = 'manual',
      productIds = [],
      buyerName,
      buyerPhone,
      notes
    } = req.body;

    if (!productIds.length) {
      return res.status(400).json({ success: false, error: 'At least one product is required' });
    }

    const products = await Product.find({
      _id: { $in: productIds },
      organization: orgId(req),
      isActive: true
    }).lean();

    if (!products.length) {
      return res.status(400).json({ success: false, error: 'No matching active products found' });
    }

    const lineItems = products.map((p) => ({
      product: p._id,
      retailerId: p.sku || p._id.toString(),
      name: p.name,
      qty: 1,
      unitPrice: p.discountPercent
        ? +(p.price * (1 - p.discountPercent / 100)).toFixed(2)
        : p.price,
      currency: p.currency || 'AED'
    }));

    const totalAmount = lineItems.reduce((sum, item) => sum + (item.unitPrice * item.qty), 0);

    const order = await CommerceOrder.create(
      await assignOrderDisplayRef(orgId(req), {
        organization: orgId(req),
        channel,
        status: 'product_sent',
        lineItems,
        totalAmount: +totalAmount.toFixed(2),
        currency: lineItems[0]?.currency || 'AED',
        buyerName,
        buyerPhone,
        notes
      })
    );

    res.status(201).json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
};

// ── CANCEL ────────────────────────────────────────────────────────────────────

exports.cancelOrder = async (req, res, next) => {
  try {
    const order = await CommerceOrder.findOneAndUpdate(
      { _id: req.params.id, organization: orgId(req) },
      { $set: { status: 'cancelled' } },
      { new: true }
    );
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    res.json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
};
