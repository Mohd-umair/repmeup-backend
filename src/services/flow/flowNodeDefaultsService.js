/**
 * Merges static node defaults with org-specific automation settings.
 */
const Organization = require('../../models/Organization');
const { getNodeCatalog, getStaticDefaultConfig } = require('../../config/flowNodeCatalog');

const RESPONSE_STYLE_TO_TONE = {
  formal: 'professional',
  professional: 'professional',
  balanced: 'friendly',
  friendly: 'friendly',
  casual: 'casual'
};

function isNonEmpty(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return !Number.isNaN(value);
  return true;
}

function mergeConfig(staticDefaults, orgOverrides) {
  const merged = { ...staticDefaults };
  for (const [key, value] of Object.entries(orgOverrides || {})) {
    if (isNonEmpty(value)) merged[key] = value;
  }
  return merged;
}

/**
 * Build org-specific default overrides keyed by node type.
 * @param {object} org - lean Organization doc
 */
function buildOrgOverridesByType(org) {
  const ctd = org.commentToDmSettings || {};
  const story = org.storyToDmSettings || {};
  const sales = org.salesFlowSettings || {};
  const follow = org.commentFollowInviteSettings || {};
  const auto = org.autoReplySettings || {};
  const esc = org.escalationSettings || {};

  const tone = RESPONSE_STYLE_TO_TONE[auto.responseStyle] || 'friendly';
  const humanMin = auto.webhookDelayMinMinutes != null ? auto.webhookDelayMinMinutes * 60 : null;
  const humanMax = auto.webhookDelayMaxMinutes != null ? auto.webhookDelayMaxMinutes * 60 : null;

  const genericFromStory = {
    title: story.welcomeTitle || '',
    subtitle: story.welcomeSubtitle || '',
    imageUrl: story.welcomeImageUrl || '',
    buttons: []
  };
  const genericFromSales = {
    title: sales.ctaTitle || '',
    subtitle: sales.ctaSubtitle || '',
    imageUrl: sales.ctaImageUrl || '',
    buttons: sales.ctaButtons || []
  };
  const genericFromFollow = {
    title: follow.title || '',
    subtitle: follow.subtitle || '',
    imageUrl: follow.imageUrl || '',
    buttons: [{ label: follow.buttonTitle || 'Follow us', type: 'web_url', url: follow.buttonUrl || '' }]
  };

  let genericTemplate = {};
  if (isNonEmpty(genericFromSales.title) || isNonEmpty(genericFromSales.buttons)) {
    genericTemplate = genericFromSales;
  } else if (isNonEmpty(genericFromStory.title)) {
    genericTemplate = genericFromStory;
  } else if (isNonEmpty(genericFromFollow.title)) {
    genericTemplate = genericFromFollow;
  }

  const overrides = {};

  if (isNonEmpty(ctd.triggerKeywords)) {
    overrides['trigger.ig_comment'] = { keywords: ctd.triggerKeywords };
    overrides['condition.keyword_match'] = { keywords: ctd.triggerKeywords };
  }
  if (isNonEmpty(ctd.publicReplyTemplate)) {
    overrides['action.reply_public_comment'] = { text: ctd.publicReplyTemplate };
  }
  if (isNonEmpty(ctd.dmTemplate)) {
    overrides['action.send_text'] = { text: ctd.dmTemplate };
  }
  if (isNonEmpty(story.triggerKeywords)) {
    overrides['trigger.ig_story_reply'] = { keywords: story.triggerKeywords };
  }
  if (isNonEmpty(genericTemplate)) {
    overrides['action.send_generic_template'] = genericTemplate;
  }
  if (tone) {
    overrides['action.ai_reply'] = { tone };
  }
  if (isNonEmpty(esc.handoffMessageTemplate)) {
    overrides['action.escalate_human'] = { reason: esc.handoffMessageTemplate };
  } else {
    overrides['action.escalate_human'] = { reason: 'Needs human review' };
  }
  if (ctd.maxDmsPerDay != null) {
    overrides['condition.dedup_rate_limit'] = { maxPerDay: ctd.maxDmsPerDay };
  }
  if (auto.webhookDelayMode === 'human' && humanMin != null && humanMax != null) {
    overrides['wait.human_delay'] = { minSec: humanMin, maxSec: humanMax };
  }
  if (isNonEmpty(sales.whatsappCaptureMessage)) {
    overrides['action.send_text'] = overrides['action.send_text'] || {};
    if (!isNonEmpty(overrides['action.send_text'].text)) {
      overrides['action.send_text'].text = sales.whatsappCaptureMessage;
    }
  }

  return overrides;
}

/**
 * @param {import('mongoose').Types.ObjectId|string} organizationId
 * @param {{ channels?: string[], category?: string }} filters
 */
async function getCatalogWithDefaults(organizationId, filters = {}) {
  const org = organizationId
    ? await Organization.findById(organizationId)
      .select('commentToDmSettings storyToDmSettings salesFlowSettings commentFollowInviteSettings autoReplySettings escalationSettings')
      .lean()
    : null;

  const orgOverrides = org ? buildOrgOverridesByType(org) : {};
  const catalog = getNodeCatalog(filters);

  return catalog.map((item) => ({
    ...item,
    defaultConfig: mergeConfig(item.defaultConfig || {}, orgOverrides[item.type])
  }));
}

/**
 * Resolved default config for a single node type (static + org).
 */
async function getDefaultConfigForType(organizationId, nodeType) {
  const staticDefaults = getStaticDefaultConfig(nodeType);
  if (!organizationId) return staticDefaults;

  const org = await Organization.findById(organizationId)
    .select('commentToDmSettings storyToDmSettings salesFlowSettings commentFollowInviteSettings autoReplySettings escalationSettings')
    .lean();
  if (!org) return staticDefaults;

  const orgOverrides = buildOrgOverridesByType(org);
  return mergeConfig(staticDefaults, orgOverrides[nodeType]);
}

module.exports = {
  getCatalogWithDefaults,
  getDefaultConfigForType,
  buildOrgOverridesByType,
  mergeConfig
};
