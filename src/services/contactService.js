/**
 * Contact Identity Service
 *
 * Core principle: 1 Contact = 1 Person = Multiple Identities (channels).
 *
 * This service is the single source of truth for resolving who a customer is
 * across all platforms. It is called from every webhook handler.
 */
const Contact = require('../models/Contact');
const logger = require('../config/logger');
const entitlementsService = require('./entitlementsService');
const { FEATURE_KEYS } = require('../config/featureCatalog');

/** Meta Graph `/picture` URLs need a token — store null and let the inbox proxy resolve. */
function sanitizeAvatarUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.includes('graph.facebook.com') && trimmed.includes('/picture')) return null;
  return trimmed;
}

/**
 * Increment the per-org "unique contacts this month" bucket when this contact
 * counts as new for the current period.
 *
 * "New for the period" means either:
 *   - the Contact was created in this call, OR
 *   - the Contact's previous `lastInteractionAt` falls in a calendar month
 *     before `now`.
 *
 * Failures here are NEVER fatal: contact resolution must keep working even if
 * Redis/Mongo writes for usage tracking fail. We log and continue.
 */
function isLastInteractionInPriorPeriod(prev, now) {
  if (!prev) return true;
  const p = prev instanceof Date ? prev : new Date(prev);
  return p.getUTCFullYear() !== now.getUTCFullYear() || p.getUTCMonth() !== now.getUTCMonth();
}

async function tickUniqueContactsBucket(organizationId, contact, prevLastInteractionAt) {
  try {
    const now = new Date();
    if (!isLastInteractionInPriorPeriod(prevLastInteractionAt, now)) return;
    await entitlementsService.consume(
      organizationId,
      FEATURE_KEYS.INBOX_UNIQUE_CONTACTS,
      1
    );
  } catch (err) {
    logger.warn('[contactService] uniqueContacts bucket consume failed (non-fatal)', {
      contactId: contact?._id?.toString(),
      err: err.message
    });
  }
}

// ─── Platform Normalizer ───────────────────────────────────────────────────
/**
 * Maps an Interaction.author object (already built by processWebhook.js) into
 * the standard resolveContact payload shape.
 *
 * @param {string} platform - platform name (instagram, facebook, etc.)
 * @param {object} author - Interaction.author sub-document
 * @param {object} [rawData={}] - raw webhook payload (optional, stored for enrichment)
 * @returns {{ platform, platformUserId, phone, email, username, name, avatarUrl, rawData }}
 */
function normalizeAuthorForPlatform(platform, author = {}, rawData = {}) {
  const base = {
    platform,
    platformUserId: author.platformId || null,
    phone: author.phone || null,
    email: author.email || null,
    username: author.username || null,
    name: author.name || author.username || null,
    avatarUrl: sanitizeAvatarUrl(author.avatarUrl || author.profilePicture) || null,
    rawData
  };

  // Platform-specific enrichment
  switch (platform) {
    case 'whatsapp':
      // WhatsApp author.platformId is the phone number (MSISDN format)
      if (author.platformId && !base.phone) {
        base.phone = author.platformId;
      }
      break;
    case 'instagram':
    case 'facebook':
    case 'youtube':
    case 'google':
    case 'linkedin':
    case 'twitter':
      // platformId is the social user id — already set in base
      break;
    default:
      break;
  }

  return base;
}

// ─── Identity Resolver ─────────────────────────────────────────────────────
/**
 * Resolve (find or create) a Contact for an incoming message.
 *
 * Lookup priority:
 *  1. Phone number match (strongest identity signal)
 *  2. Email match
 *  3. Platform channel match (platform + platformUserId within same org)
 *  4. Create new contact
 *
 * On match: adds channel if not present, enriches missing fields, updates lastInteractionAt.
 *
 * @param {{ platform, platformUserId, phone, email, username, name, avatarUrl, rawData }} payload
 * @param {string|ObjectId} organizationId
 * @returns {Promise<Contact>}
 */
async function resolveContact(payload, organizationId) {
  const { platform, platformUserId, phone, email, username, name, avatarUrl: rawAvatarUrl, rawData } = payload;
  const avatarUrl = sanitizeAvatarUrl(rawAvatarUrl);

  if (!platformUserId || !platform) {
    // Not enough identity info — skip silently
    return null;
  }

  const orgId = organizationId?.toString ? organizationId.toString() : organizationId;

  try {
    let contact = null;

    // 1. Phone match (strongest signal — merges cross-platform identity)
    if (phone) {
      contact = await Contact.findOne({ organization: orgId, primaryPhone: phone, isDeleted: false });
    }

    // 2. Email match
    if (!contact && email) {
      contact = await Contact.findOne({ organization: orgId, primaryEmail: email, isDeleted: false });
    }

    // 3. Platform channel match
    if (!contact) {
      contact = await Contact.findOne({
        organization: orgId,
        isDeleted: false,
        channels: { $elemMatch: { platform, platformUserId: String(platformUserId) } }
      });
    }

    // 4. Create new contact
    if (!contact) {
      const storedCount = await Contact.countDocuments({ organization: orgId, isDeleted: false });
      const contactQuota = await entitlementsService.quota(orgId, FEATURE_KEYS.CONTACTS_MAX);
      if (!contactQuota.isUnlimited && storedCount >= contactQuota.limit) {
        logger.warn('[contactService] contacts.max reached — skipping new contact create', {
          organizationId: orgId,
          storedCount,
          limit: contactQuota.limit
        });
        return null;
      }

      contact = await Contact.create({
        organization: orgId,
        primaryName: name || username || 'Unknown',
        primaryPhone: phone || null,
        primaryEmail: email || null,
        channels: [{
          platform,
          platformUserId: String(platformUserId),
          username: username || null,
          name: name || username || null,
          avatarUrl: avatarUrl || null,
          rawData: rawData || {}
        }],
        lastInteractionAt: new Date()
      });
      // Brand-new contact => count it toward this month's unique-contacts bucket.
      await tickUniqueContactsBucket(orgId, contact, null);
      return contact;
    }

    const prevLastInteractionAt = contact.lastInteractionAt;

    // ── Enrich existing contact ─────────────────────────────────────────────

    // Add channel if not already present
    const channelExists = contact.channels.some(
      ch => ch.platform === platform && String(ch.platformUserId) === String(platformUserId)
    );

    if (!channelExists) {
      contact.channels.push({
        platform,
        platformUserId: String(platformUserId),
        username: username || null,
        name: name || username || null,
        avatarUrl: avatarUrl || null,
        rawData: rawData || {}
      });
    } else {
      // Update existing channel with latest profile data (avatar, username may change)
      const ch = contact.channels.find(
        c => c.platform === platform && String(c.platformUserId) === String(platformUserId)
      );
      if (ch) {
        const safeAvatar = sanitizeAvatarUrl(avatarUrl);
        if (safeAvatar) ch.avatarUrl = safeAvatar;
        if (username && !ch.username) ch.username = username;
        if (name && !ch.name) ch.name = name;
      }
    }

    // Enrich primary fields (never overwrite existing data)
    if (!contact.primaryPhone && phone) contact.primaryPhone = phone;
    if (!contact.primaryEmail && email) contact.primaryEmail = email;
    if (contact.primaryName === 'Unknown' && (name || username)) {
      contact.primaryName = name || username;
    }

    contact.lastInteractionAt = new Date();
    contact.updatedAt = new Date();

    await contact.save();

    // Existing contact, but maybe first interaction this month → counts as a
    // distinct contact for the unique-contacts bucket.
    await tickUniqueContactsBucket(orgId, contact, prevLastInteractionAt);

    return contact;

  } catch (err) {
    // Non-fatal — contact resolution must never block message delivery
    logger.warn('[contactService] resolveContact failed (non-fatal)', {
      platform,
      platformUserId,
      organizationId: orgId,
      error: err.message
    });
    return null;
  }
}

// ─── AI Insights Updater ───────────────────────────────────────────────────
/**
 * Update AI insights on a Contact after an AI reply is processed.
 * Uses findByIdAndUpdate — no load/save round trip needed.
 *
 * @param {string|ObjectId} contactId
 * @param {{ intent?, sentiment?, priority? }} insights
 */
async function updateAIInsights(contactId, insights = {}) {
  if (!contactId) return;
  try {
    const update = { 'aiInsights.updatedAt': new Date() };
    if (insights.intent) update['aiInsights.intent'] = insights.intent;
    if (insights.sentiment) update['aiInsights.sentiment'] = insights.sentiment;
    if (insights.priority) update['aiInsights.priority'] = insights.priority;

    await Contact.findByIdAndUpdate(contactId, { $set: update });
  } catch (err) {
    logger.warn('[contactService] updateAIInsights failed (non-fatal)', {
      contactId: contactId?.toString(),
      error: err.message
    });
  }
}

module.exports = {
  resolveContact,
  normalizeAuthorForPlatform,
  updateAIInsights,
  // Exported for tests
  _isLastInteractionInPriorPeriod: isLastInteractionInPriorPeriod
};
