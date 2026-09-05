'use strict';

const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const CommerceOrder = require('../models/CommerceOrder');
const ContactActivity = require('../models/ContactActivity');
const Campaign = require('../models/Campaign');
const { record } = require('./contactActivityService');

const PAID_STATUSES = new Set(['paid', 'shipped', 'delivered', 'completed']);

async function refreshContactMetrics(orgId, contactId) {
  const [metrics] = await CommerceOrder.aggregate([
    {
      $match: {
        organization: new mongoose.Types.ObjectId(String(orgId)),
        contact: new mongoose.Types.ObjectId(String(contactId)),
        $or: [
          { status: { $in: [...PAID_STATUSES] } },
          { status: { $exists: false } },
          { status: null }
        ]
      }
    },
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalSpent: { $sum: { $ifNull: ['$totalAmount', 0] } },
        lastOrderAt: { $max: '$createdAt' }
      }
    }
  ]);
  const totalOrders = metrics?.totalOrders || 0;
  const totalSpent = metrics?.totalSpent || 0;
  const lastOrderAt = metrics?.lastOrderAt || null;
  const avgOrderValue = totalOrders ? Math.round((totalSpent / totalOrders) * 100) / 100 : 0;

  await Contact.updateOne(
    { _id: contactId, organization: orgId },
    {
      $set: {
        'commerceMetrics.totalOrders': totalOrders,
        'commerceMetrics.totalSpent': totalSpent,
        'commerceMetrics.avgOrderValue': avgOrderValue,
        'commerceMetrics.lastOrderAt': lastOrderAt
      }
    }
  );
  return { totalOrders, totalSpent, avgOrderValue, lastOrderAt };
}

async function listOrders(orgId, contactId, { page = 1, limit = 20 } = {}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const q = { organization: orgId, contact: contactId };
  const [items, total] = await Promise.all([
    CommerceOrder.find(q).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
    CommerceOrder.countDocuments(q)
  ]);
  return { items, pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) } };
}

async function attributeOrder(orgId, order) {
  if (!order?._id || !order.contact || !order.sourceInteraction) return null;
  const viaInteraction = await ContactActivity.findOne({
    organization: orgId,
    relatedInteraction: order.sourceInteraction,
    relatedCampaign: { $ne: null }
  }).select('relatedCampaign').lean();
  const campaignId = viaInteraction?.relatedCampaign || null;
  if (!campaignId) return null;

  const amount = Number(order.totalAmount || 0);
  const attributed = await CommerceOrder.findOneAndUpdate(
    {
      _id: order._id,
      organization: orgId,
      $or: [{ attributedCampaign: null }, { attributedCampaign: { $exists: false } }]
    },
    { $set: { attributedCampaign: campaignId, attributedAmount: amount } },
    { new: true }
  ).lean();
  if (!attributed) {
    const existing = await CommerceOrder.findOne({ _id: order._id, organization: orgId })
      .select('attributedCampaign attributedAmount')
      .lean();
    if (!existing || String(existing.attributedCampaign) !== String(campaignId)) return existing?.attributedCampaign || null;
    const delta = amount - Number(existing.attributedAmount || 0);
    if (!delta) return campaignId;
    const adjusted = await CommerceOrder.updateOne(
      { _id: order._id, organization: orgId, attributedCampaign: campaignId, attributedAmount: existing.attributedAmount },
      { $set: { attributedAmount: amount } }
    );
    if (!adjusted.modifiedCount) return campaignId;
    await Campaign.updateOne(
      { _id: campaignId, organization: orgId },
      { $inc: { 'stats.revenue': delta } }
    );
    return campaignId;
  }

  await Campaign.updateOne(
    { _id: campaignId, organization: orgId },
    { $inc: { 'stats.revenue': amount, 'stats.attributedOrders': 1 } }
  );
  await record({
    organization: orgId,
    contact: order.contact,
    type: 'order_attributed',
    channel: order.channel || 'shopify',
    relatedOrder: order._id,
    relatedCampaign: campaignId,
    payload: { totalAmount: order.totalAmount },
    idempotencyKey: `order-attributed:${order._id}`
  });
  return campaignId;
}

async function onOrderUpserted(orgId, order) {
  if (!order?.contact) return;
  await refreshContactMetrics(orgId, order.contact);
  await record({
    organization: orgId,
    contact: order.contact,
    type: 'order_placed',
    channel: order.channel || 'shopify',
    relatedOrder: order._id,
    payload: { totalAmount: order.totalAmount, status: order.status },
    idempotencyKey: `order-placed:${order._id}`
  });
  await attributeOrder(orgId, order);
}

module.exports = { refreshContactMetrics, listOrders, onOrderUpserted, attributeOrder };
