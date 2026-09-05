'use strict';

/**
 * WhatsApp pass-through cost tracking.
 *
 * Meta's delivery-status webhooks carry a `pricing` object (billable, category) and a
 * `conversation` object (id, origin, expiry). Until now both were received and thrown
 * away, so the platform had no idea what WhatsApp actually costs per customer.
 *
 * Two rules shape everything here:
 *   1. Meta bills per CONVERSATION (a 24h window), not per message — so the first
 *      status carrying a new conversation id creates the charge, and everything after
 *      it just increments a counter.
 *   2. Rates are effective-dated data, and each charge snapshots the rate it was
 *      billed at — so a Meta price change never rewrites history.
 *
 * Nothing in here may ever break message delivery: every entry point is wrapped by
 * the caller in a try/catch, and the functions themselves swallow their own errors.
 */

const WhatsAppConversationCharge = require('../models/WhatsAppConversationCharge');
const WhatsAppRateCard = require('../models/WhatsAppRateCard');
const cacheService = require('./cacheService');
const logger = require('../config/logger');

const RATE_CACHE_TTL_SECONDS = 300;
const DEFAULT_COUNTRY = 'IN';

function monthKeyUTC(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function formatRupees(paise) {
  const rupees = (Number(paise) || 0) / 100;
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The rate for a category at a point in time, in paise.
 * Returns 0 when no card covers it — an unknown rate must never invent a charge.
 */
async function resolveRate(category, at = new Date(), country = DEFAULT_COUNTRY) {
  if (!category) return 0;
  const cacheKey = `wa:rate:${country}:${category}:${monthKeyUTC(at)}`;

  try {
    const cached = await cacheService.get(cacheKey);
    if (cached != null) return Number(cached) || 0;
  } catch { /* cache is an optimisation, never a dependency */ }

  const card = await WhatsAppRateCard.findOne({
    country,
    category,
    effectiveFrom: { $lte: at },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: at } }]
  })
    .sort({ effectiveFrom: -1 })
    .lean();

  const rate = card?.rateInr ?? 0;
  try {
    await cacheService.set(cacheKey, rate, RATE_CACHE_TTL_SECONDS);
  } catch { /* ignore */ }
  return rate;
}

/**
 * Record a WhatsApp status webhook against its conversation charge.
 *
 * @param {string|ObjectId} organizationId
 * @param {object} status - a single entry from webhook `value.statuses[]`
 * @param {object} [options] - { campaignId }
 * @returns {Promise<{ recorded: boolean, created?: boolean, reason?: string }>}
 */
async function recordConversationCharge(organizationId, status, { campaignId } = {}) {
  try {
    const conversation = status?.conversation;
    const wabaConversationId = conversation?.id;

    // No conversation object means Meta isn't billing this status (e.g. a plain
    // 'failed'), so there is nothing to record.
    if (!organizationId || !wabaConversationId) {
      return { recorded: false, reason: 'no_conversation' };
    }

    const pricing = status.pricing || {};
    const category = pricing.category || conversation.origin?.type || 'unknown';
    // Meta says explicitly when a conversation is free — trust it over the rate card.
    const billable = pricing.billable !== false;

    const existing = await WhatsAppConversationCharge.findOne({
      organization: organizationId,
      wabaConversationId
    }).select('_id');

    if (existing) {
      await WhatsAppConversationCharge.updateOne(
        { _id: existing._id },
        { $inc: { messageCount: 1 } }
      );
      return { recorded: true, created: false };
    }

    const at = status.timestamp
      ? new Date(parseInt(status.timestamp, 10) * 1000)
      : new Date();
    const rateInr = billable ? await resolveRate(category, at) : 0;

    await WhatsAppConversationCharge.create({
      organization: organizationId,
      wabaConversationId,
      category: WhatsAppConversationCharge.CATEGORIES.includes(category) ? category : 'unknown',
      originType: conversation.origin?.type || null,
      billable,
      rateInr,
      startedAt: at,
      expiresAt: conversation.expiration_timestamp
        ? new Date(parseInt(conversation.expiration_timestamp, 10) * 1000)
        : null,
      messageCount: 1,
      campaign: campaignId || null,
      periodMonthKey: monthKeyUTC(at)
    });

    return { recorded: true, created: true };
  } catch (err) {
    // A duplicate means a concurrent webhook created the charge first. Billing is
    // already correct (one charge), but this status still represents a real message,
    // so count it rather than dropping it.
    if (err?.code === 11000) {
      await WhatsAppConversationCharge.updateOne(
        { organization: organizationId, wabaConversationId: status.conversation.id },
        { $inc: { messageCount: 1 } }
      ).catch(() => {});
      return { recorded: true, created: false };
    }

    logger.warn('[whatsappCost] failed to record conversation charge (non-fatal)', {
      organizationId: String(organizationId),
      error: err.message
    });
    return { recorded: false, reason: 'error' };
  }
}

/**
 * Monthly spend summary for an organization, display-ready.
 * Aggregated in Mongo; the caller renders strings.
 */
async function getSpendSummary(organizationId, { from, to } = {}) {
  const match = { organization: organizationId };
  if (from || to) {
    match.startedAt = {};
    if (from) match.startedAt.$gte = new Date(from);
    if (to) match.startedAt.$lte = new Date(to);
  } else {
    match.periodMonthKey = monthKeyUTC();
  }

  const rows = await WhatsAppConversationCharge.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$category',
        conversations: { $sum: 1 },
        messages: { $sum: '$messageCount' },
        amountInr: { $sum: '$rateInr' }
      }
    },
    { $sort: { amountInr: -1 } }
  ]);

  const LABELS = {
    marketing: 'Marketing',
    utility: 'Utility',
    authentication: 'Authentication',
    service: 'Service',
    referral_conversion: 'Referral conversion',
    unknown: 'Uncategorised'
  };

  const categories = rows.map((r) => ({
    category: r._id,
    label: LABELS[r._id] || r._id,
    conversations: r.conversations,
    messages: r.messages,
    amountInr: r.amountInr,
    amountDisplay: formatRupees(r.amountInr)
  }));

  const totalPaise = rows.reduce((sum, r) => sum + (r.amountInr || 0), 0);

  return {
    periodMonthKey: match.periodMonthKey || null,
    totalInr: totalPaise,
    totalDisplay: formatRupees(totalPaise),
    conversations: rows.reduce((s, r) => s + r.conversations, 0),
    messages: rows.reduce((s, r) => s + r.messages, 0),
    categories
  };
}

/**
 * What a campaign actually cost, once its conversations were billed.
 * Pre-launch estimation lives in the campaign UI; this is the settled number.
 */
async function getCampaignSpend(campaignId) {
  const rows = await WhatsAppConversationCharge.aggregate([
    { $match: { campaign: campaignId } },
    { $group: { _id: null, conversations: { $sum: 1 }, amountInr: { $sum: '$rateInr' } } }
  ]);
  const row = rows[0] || { conversations: 0, amountInr: 0 };
  return {
    conversations: row.conversations,
    amountInr: row.amountInr,
    amountDisplay: formatRupees(row.amountInr)
  };
}

module.exports = {
  resolveRate,
  recordConversationCharge,
  getSpendSummary,
  getCampaignSpend,
  monthKeyUTC,
  formatRupees
};
