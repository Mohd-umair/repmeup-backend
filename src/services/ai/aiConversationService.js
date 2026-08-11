'use strict';

/**
 * AI conversation metering — the headline meter on the 2026 pricing sheet.
 *
 * One credit buys a 24-hour conversation window with a contact. The first AI reply
 * opens the window; every further AI reply to that contact inside it is free.
 *
 * Two calls, deliberately split:
 *   assertCapacity() — BEFORE the LLM call, so we never pay a vendor for a reply
 *                      the plan won't let us send.
 *   openOrReuse()    — AFTER the reply is committed, so a draft that never ships
 *                      isn't charged.
 *
 * Both are safe to call more than once for the same contact inside a window: the
 * window is idempotent by construction, so ordering across the various AI send
 * paths does not matter and there is no double-charge risk.
 *
 * Relationship to the older credit pools: `credits.aiConversations.monthly` is the
 * customer-facing meter (enforced, displayed, rechargeable). `credits.ai.monthly`
 * remains the internal vendor-cost pool for non-conversational AI (post generation,
 * KB ingestion, summaries). They measure different things and both stay.
 *
 * Conversation credits do NOT carry forward between months — unlike the AI credit
 * pool — because carry-forward would undercut the paid recharge SKU.
 */

const AiConversationWindow = require('../../models/AiConversationWindow');
const entitlementsService = require('../entitlementsService');
const { FEATURE_KEYS } = require('../../config/featureCatalog');
const { monthKeyUTC } = require('../creditPeriodService');
const logger = require('../../config/logger');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const CONVERSATION_CREDITS = 1;
/** Bounded retry for the E11000 that a concurrent opener can cause. */
const MAX_OPEN_ATTEMPTS = 3;

function toId(value) {
  return value?._id ? String(value._id) : (value ? String(value) : null);
}

/** The live window for this contact, or null. Expired windows are deactivated in passing. */
async function findOpenWindow(organizationId, contactId, now = new Date()) {
  const open = await AiConversationWindow.findOne({
    organization: organizationId,
    contact: contactId,
    active: true
  });
  if (!open) return null;

  if (open.expiresAt > now) return open;

  // Expired — release it so the partial unique index allows a fresh window.
  await AiConversationWindow.updateOne({ _id: open._id }, { $unset: { active: 1 } });
  return null;
}

/**
 * Would sending an AI reply to this contact cost a credit, and can the org afford it?
 * Throws EntitlementError (402 QUOTA_EXCEEDED) when the monthly allowance is spent.
 *
 * Call this BEFORE generating the reply.
 *
 * @returns {Promise<{ wouldCharge: boolean, windowId: string|null }>}
 */
async function assertCapacity(organizationId, contactId) {
  const orgId = toId(organizationId);
  const cId = toId(contactId);
  // No contact resolved (e.g. the contact cap dropped it) — nothing to meter against.
  if (!orgId || !cId) return { wouldCharge: false, windowId: null };

  const open = await findOpenWindow(orgId, cId);
  if (open) return { wouldCharge: false, windowId: String(open._id) };

  await entitlementsService.assert(
    orgId,
    FEATURE_KEYS.CREDITS_AI_CONVERSATIONS,
    CONVERSATION_CREDITS
  );
  return { wouldCharge: true, windowId: null };
}

/**
 * Record an AI reply against this contact's conversation window, opening (and
 * charging for) a new one if none is live.
 *
 * Call this AFTER the reply is committed. Never throws — a metering failure must
 * not undo a message the customer already received; it is logged for reconciliation.
 *
 * @returns {Promise<{ charged: boolean, isNew: boolean, windowId: string|null, expiresAt: Date|null }>}
 */
async function openOrReuse(organizationId, contactId, { channel, interactionId } = {}) {
  const orgId = toId(organizationId);
  const cId = toId(contactId);
  if (!orgId || !cId) return { charged: false, isNew: false, windowId: null, expiresAt: null };

  for (let attempt = 1; attempt <= MAX_OPEN_ATTEMPTS; attempt += 1) {
    const now = new Date();
    try {
      const open = await findOpenWindow(orgId, cId, now);

      if (open) {
        await AiConversationWindow.updateOne(
          { _id: open._id },
          {
            $inc: { messageCount: 1 },
            $set: { lastAiReplyAt: now },
            ...(channel ? { $addToSet: { channels: channel } } : {})
          }
        );
        return {
          charged: false,
          isNew: false,
          windowId: String(open._id),
          expiresAt: open.expiresAt
        };
      }

      // Unlimited plans still get a window (so reuse works and reporting is complete)
      // but the bucket is not incremented.
      const quota = await entitlementsService.quota(orgId, FEATURE_KEYS.CREDITS_AI_CONVERSATIONS);
      const willCharge = !quota.isUnlimited;

      const created = await AiConversationWindow.create({
        organization: orgId,
        contact: cId,
        openedAt: now,
        expiresAt: new Date(now.getTime() + WINDOW_MS),
        active: true,
        messageCount: 1,
        lastAiReplyAt: now,
        channels: channel ? [channel] : [],
        periodMonthKey: monthKeyUTC(now),
        charged: willCharge
      });

      if (willCharge) {
        await entitlementsService.consume(
          orgId,
          FEATURE_KEYS.CREDITS_AI_CONVERSATIONS,
          CONVERSATION_CREDITS
        );
      }

      logger.info('[aiConversation] window opened', {
        organizationId: orgId,
        contactId: cId,
        windowId: String(created._id),
        charged: willCharge,
        interactionId: interactionId ? String(interactionId) : undefined
      });

      return {
        charged: willCharge,
        isNew: true,
        windowId: String(created._id),
        expiresAt: created.expiresAt
      };
    } catch (err) {
      // A concurrent reply won the race and opened the window first — loop and reuse it.
      if (err?.code === 11000 && attempt < MAX_OPEN_ATTEMPTS) continue;

      logger.error('[aiConversation] failed to record conversation window (non-fatal)', {
        organizationId: orgId,
        contactId: cId,
        attempt,
        error: err.message
      });
      return { charged: false, isNew: false, windowId: null, expiresAt: null };
    }
  }

  return { charged: false, isNew: false, windowId: null, expiresAt: null };
}

/**
 * Current-month conversation usage for an org, display-ready.
 * Used by the billing meters and the reconciliation script.
 */
async function getUsage(organizationId) {
  const orgId = toId(organizationId);
  const quota = await entitlementsService.quota(orgId, FEATURE_KEYS.CREDITS_AI_CONVERSATIONS);
  const windowsThisMonth = await AiConversationWindow.countDocuments({
    organization: orgId,
    periodMonthKey: monthKeyUTC(new Date()),
    charged: true
  });

  return {
    limit: quota.limit,
    used: quota.used,
    remaining: quota.isUnlimited ? null : quota.remaining,
    isUnlimited: quota.isUnlimited,
    isExhausted: quota.isExhausted,
    /** Independent count from the window ledger — should match `used`. */
    windowsThisMonth,
    periodStart: quota.periodStart
  };
}

module.exports = {
  assertCapacity,
  openOrReuse,
  getUsage,
  findOpenWindow,
  WINDOW_MS,
  CONVERSATION_CREDITS
};
