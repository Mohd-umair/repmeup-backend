/**
 * Canonical entitlement maps for default plan seeds and admin tier presets.
 * Keep in sync with admin/src/app/features/plans/plan-tier-presets.ts
 *
 * The 2026 pricing-sheet tiers (Starter/Growth/Pro) live in pricingSheetEntitlements.js;
 * this file covers the legacy lineup plus the derived Enterprise map.
 */

const { CATALOG } = require('../src/config/featureCatalog');

const FREE_ENTITLEMENTS = {
  'users.max': { limit: 1 },
  'accounts.max': { limit: 2 },
  'credits.ai.monthly': { limit: 50 },
  'credits.autoReply.monthly': { limit: 0 },
  'credits.postCreation.monthly': { limit: 50 },
  'storage.gb': { limit: 1 },
  'inbox.uniqueContacts.monthly': { limit: 50 },
  'posts.perMonth': { limit: 10 },
  'commerce.products.max': { limit: 5 },
  'campaigns.recipients.monthly': { limit: 0 },
  'kb.entries.max': { limit: 2 },
  'posts.platforms.maxPerPost': { limit: 1 },
  'posts.ai.variants.max': { limit: 2 },
  'automation.autoReply.enabled': { enabled: false },
  'analytics.advanced': { enabled: false },
  'agents.enabled': { enabled: false },
  'voice.ivr.enabled': { enabled: false },
  'commerce.whatsappCatalog.enabled': { enabled: false },
  'commerce.aiAssist.enabled': { enabled: false },
  'commerce.autonomousAgent.enabled': { enabled: false },
  'campaigns.enabled': { enabled: false },
  'whatsapp.broadcast.enabled': { enabled: false },
  'inbox.bucket.chat': { enabled: false },
  'inbox.bucket.create': { enabled: false },
  'inbox.messageSuggestions.enabled': { enabled: true },

  'posts.trends': { enabled: false },
  'posts.logo': { enabled: false },
  'posts.saveDraft': { enabled: false },
  'kb.upload.url': { enabled: false },
  'kb.upload.pdf': { enabled: true }
};

const STARTER_ENTITLEMENTS = {
  'users.max': { limit: 3 },
  'accounts.max': { limit: 5 },
  'credits.ai.monthly': { limit: 500 },
  'credits.autoReply.monthly': { limit: 200 },
  'credits.postCreation.monthly': { limit: 100 },
  'storage.gb': { limit: 5 },
  'inbox.uniqueContacts.monthly': { limit: 500 },
  'posts.perMonth': { limit: 100 },
  'commerce.products.max': { limit: 50 },
  'campaigns.recipients.monthly': { limit: 1000 },
  'kb.entries.max': { limit: 25 },
  'posts.platforms.maxPerPost': { limit: 3 },
  'posts.ai.variants.max': { limit: 4 },
  'automation.autoReply.enabled': { enabled: true },
  'analytics.advanced': { enabled: false },
  'agents.enabled': { enabled: true },
  'voice.ivr.enabled': { enabled: false },
  'commerce.whatsappCatalog.enabled': { enabled: true },
  'commerce.aiAssist.enabled': { enabled: true },
  'commerce.autonomousAgent.enabled': { enabled: false },
  'campaigns.enabled': { enabled: true },
  'whatsapp.broadcast.enabled': { enabled: true },
  'inbox.bucket.chat': { enabled: true },
  'inbox.bucket.create': { enabled: true },
  'inbox.messageSuggestions.enabled': { enabled: true },
  'posts.trends': { enabled: true },
  'posts.logo': { enabled: true },
  'posts.saveDraft': { enabled: true },
  'kb.upload.url': { enabled: true },
  'kb.upload.pdf': { enabled: true },
  'whatsapp.templates.max': { limit: 20 },
  'contacts.max': { limit: 5000 }
};

const PRO_ENTITLEMENTS = {
  'users.max': { limit: 15 },
  'accounts.max': { limit: 20 },
  'credits.ai.monthly': { limit: 5000 },
  'credits.autoReply.monthly': { limit: 2000 },
  'credits.postCreation.monthly': { limit: 500 },
  'storage.gb': { limit: 20 },
  'inbox.uniqueContacts.monthly': { limit: -1 },
  'posts.perMonth': { limit: -1 },
  'commerce.products.max': { limit: -1 },
  'campaigns.recipients.monthly': { limit: 50000 },
  'kb.entries.max': { limit: -1 },
  'posts.platforms.maxPerPost': { limit: 10 },
  'posts.ai.variants.max': { limit: 8 },
  'automation.autoReply.enabled': { enabled: true },
  'analytics.advanced': { enabled: true },
  'agents.enabled': { enabled: true },
  'voice.ivr.enabled': { enabled: true },
  'commerce.whatsappCatalog.enabled': { enabled: true },
  'commerce.aiAssist.enabled': { enabled: true },
  'commerce.autonomousAgent.enabled': { enabled: true },
  'campaigns.enabled': { enabled: true },
  'whatsapp.broadcast.enabled': { enabled: true },
  'inbox.bucket.chat': { enabled: true },
  'inbox.bucket.create': { enabled: true },
  'inbox.messageSuggestions.enabled': { enabled: true },

  'posts.trends': { enabled: true },
  'posts.logo': { enabled: true },
  'posts.saveDraft': { enabled: true },
  'kb.upload.url': { enabled: true },
  'kb.upload.pdf': { enabled: true },
  'whatsapp.templates.max': { limit: -1 },
  'automation.flows.max': { limit: -1 },
  'contacts.max': { limit: -1 }
};

const BUSINESS_ENTITLEMENTS = {
  ...PRO_ENTITLEMENTS,
  'users.max': { limit: 20 },
  'accounts.max': { limit: 50 },
  'credits.ai.monthly': { limit: 10000 },
  'credits.autoReply.monthly': { limit: 10000 },
  'campaigns.recipients.monthly': { limit: 200000 }
};

/**
 * Enterprise = every capability, maxed out. Derived rather than hand-listed so a new
 * catalog key can never leave Enterprise short.
 *
 * Note this walks the CATALOG, not PRO_ENTITLEMENTS — deriving from Pro would silently
 * omit any key Pro does not name, leaving it on the (now fail-closed) catalog default.
 */
const ENTERPRISE_ENTITLEMENTS = Object.fromEntries(
  CATALOG.map((entry) => {
    switch (entry.kind) {
      case 'limit':
        return [entry.key, { limit: -1 }];
      case 'boolean':
        return [entry.key, { enabled: true }];
      case 'enum': {
        const opts = entry.enumOptions || [];
        return [entry.key, { value: opts.length ? opts[opts.length - 1] : entry.defaultValue }];
      }
      case 'list':
        return [entry.key, { value: entry.enumOptions ? [...entry.enumOptions] : [] }];
      default:
        return [entry.key, { value: entry.defaultValue ?? null }];
    }
  })
);

module.exports = {
  FREE_ENTITLEMENTS,
  STARTER_ENTITLEMENTS,
  PRO_ENTITLEMENTS,
  BUSINESS_ENTITLEMENTS,
  ENTERPRISE_ENTITLEMENTS
};
