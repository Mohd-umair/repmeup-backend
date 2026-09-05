/**
 * Builds customer-facing plan cards and the public comparison matrix from
 * admin-configured entitlements.
 *
 * Everything here returns DISPLAY-READY values — formatted prices, resolved copy,
 * computed percentages, explicit included/excluded flags. The frontend renders
 * strings; it never derives pricing or capability.
 *
 * Two audiences, deliberately kept apart:
 *   - buildPublicPlanCard()     — one plan, for the pricing cards and /app/plans.
 *   - buildComparisonMatrix()   — every plan × the pricing sheet layout.
 *
 * Note on excluded rows: the sheet advertises what a tier *lacks* (Starter shows a
 * greyed-out Intent Bucket). So unlike the previous implementation, nothing is
 * hidden for resolving to a catalog default — rows come back with `included: false`
 * and the caller decides how to grey them out.
 */

const { CATALOG_BY_KEY, FEATURE_KEYS } = require('../config/featureCatalog');
const {
  SECTIONS,
  ENUM_CELL_LABELS,
  CHANNEL_LABELS,
  HEADLINE_METRIC_LABELS
} = require('../config/pricingSheetLayout');
const { AC_NAC_LEGEND } = require('../config/acNacLegend');
const { WHATSAPP_RATES_INR_PAISE, WHATSAPP_RATES_NOTE } = require('../config/whatsappRates');
const {
  resolvePlanFeature,
  buildLegacyLimitsFromPlan
} = require('./entitlementsService');

/** Limit rows shown on the legacy pricing / billing cards (order matters). */
const CARD_LIMIT_KEYS = [
  FEATURE_KEYS.ACCOUNTS_MAX,
  FEATURE_KEYS.USERS_MAX,
  FEATURE_KEYS.POSTS_PER_MONTH,
  FEATURE_KEYS.CREDITS_AUTO_REPLY,
  FEATURE_KEYS.CREDITS_AI_GENERAL,
  FEATURE_KEYS.STORAGE_GB,
  FEATURE_KEYS.INBOX_UNIQUE_CONTACTS,
  FEATURE_KEYS.CAMPAIGNS_RECIPIENTS_MONTHLY,
  FEATURE_KEYS.COMMERCE_PRODUCTS_MAX,
  FEATURE_KEYS.WHATSAPP_TEMPLATES_MAX
];

/** Boolean module bullets for the legacy card (only shown when enabled on the plan). */
const CARD_FEATURE_KEYS = [
  FEATURE_KEYS.CAMPAIGNS_ENABLED,
  FEATURE_KEYS.WHATSAPP_BROADCAST_ENABLED,
  FEATURE_KEYS.AUTO_REPLY_ENABLED,
  FEATURE_KEYS.ANALYTICS_ADVANCED,
  FEATURE_KEYS.COMMERCE_WA_CATALOG_ENABLED,
  FEATURE_KEYS.COMMERCE_AI_ASSIST_ENABLED,
  FEATURE_KEYS.AGENTS_ENABLED,
  FEATURE_KEYS.VOICE_IVR_ENABLED,
  FEATURE_KEYS.INBOX_BUCKET_CREATE,
  FEATURE_KEYS.INBOX_BUCKET_CHAT,
  FEATURE_KEYS.KB_UPLOAD_URL,
  FEATURE_KEYS.KB_UPLOAD_PDF,
  FEATURE_KEYS.POSTS_TRENDS,
  FEATURE_KEYS.POSTS_SAVE_DRAFT
];

const EXCLUDED_CELL = '–';

// ── formatting primitives ───────────────────────────────────────────────────

function formatLimitDisplay(limit) {
  if (limit === -1) return 'Unlimited';
  if (typeof limit === 'number') return limit.toLocaleString('en-IN');
  return String(limit ?? '—');
}

function formatRupees(amount) {
  if (amount === 'custom') return 'Custom';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return 'Free';
  return `₹${n.toLocaleString('en-IN')}`;
}

function titleCase(value) {
  const s = String(value ?? '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// ── pricing block ───────────────────────────────────────────────────────────

/**
 * Monthly + annual pricing, fully formatted.
 *
 * `savingsPercent` is COMPUTED from the two prices rather than stored, so the
 * headline discount can never drift from what a customer is actually charged.
 */
function buildPricingBlock(plan) {
  const monthlyAmount = plan.price;
  const monthly = {
    amount: monthlyAmount,
    display: monthlyAmount === 'custom' ? 'Custom' : formatRupees(monthlyAmount),
    suffix: monthlyAmount === 'custom' || monthlyAmount === 0 ? null : '/mo',
    priceInr: plan.priceInr ?? null
  };

  const annualAmount = plan.priceAnnual;
  const hasAnnual =
    annualAmount !== undefined && annualAmount !== null && annualAmount !== ''
    && Number.isFinite(Number(annualAmount)) && Number(annualAmount) > 0;

  if (!hasAnnual) {
    return { monthly, annual: null };
  }

  const annualRupees = Number(annualAmount);
  const monthlyRupees = Number(monthlyAmount);
  const comparable = Number.isFinite(monthlyRupees) && monthlyRupees > 0;
  const fullYear = comparable ? monthlyRupees * 12 : null;
  const savingsPercent = fullYear ? Math.round((1 - annualRupees / fullYear) * 100) : null;

  return {
    monthly,
    annual: {
      amount: annualRupees,
      display: formatRupees(annualRupees),
      suffix: '/year',
      priceInr: plan.priceAnnualInr ?? null,
      // What the annual price works out to per month — the number customers compare.
      perMonthEquivalent: Math.round(annualRupees / 12),
      perMonthEquivalentDisplay: `${formatRupees(Math.round(annualRupees / 12))}/mo`,
      // The monthly price shown struck through beside the offer.
      strikeThrough: comparable ? `${formatRupees(monthlyRupees)}/mo` : null,
      savingsPercent,
      savingsLabel:
        plan.annualOfferLabel
        || (savingsPercent ? `Save ${savingsPercent}% — billed annually` : null)
    }
  };
}

// ── legacy card pieces (kept for /app/plans and the billing tab) ────────────

function buildHighlight(plan, featureKey) {
  const catalogEntry = CATALOG_BY_KEY[featureKey];
  if (!catalogEntry || catalogEntry.kind !== 'limit') return null;
  const resolved = resolvePlanFeature(plan, featureKey);
  if (!resolved || resolved.source === 'default') return null;
  const limit = resolved?.limit;
  if (limit === undefined || limit === null) return null;
  return {
    key: featureKey,
    label: catalogEntry.label,
    value: formatLimitDisplay(limit),
    raw: limit,
    unit: catalogEntry.unit || null,
    resetPeriod: catalogEntry.resetPeriod || null
  };
}

function buildFeatureBullet(plan, featureKey) {
  const catalogEntry = CATALOG_BY_KEY[featureKey];
  if (!catalogEntry) return null;
  const resolved = resolvePlanFeature(plan, featureKey);
  if (catalogEntry.kind === 'boolean') {
    if (!resolved?.enabled || resolved.source === 'default') return null;
    return { key: featureKey, label: catalogEntry.label };
  }
  if (catalogEntry.kind === 'limit') {
    if (resolved?.source === 'default') return null;
    const limit = resolved?.limit;
    if (limit === undefined || limit === null || limit === 0) return null;
    return {
      key: featureKey,
      label: `${catalogEntry.label}: ${formatLimitDisplay(limit)}`
    };
  }
  return null;
}

// ── pricing-sheet card pieces ───────────────────────────────────────────────

/**
 * The hero metric tiles on a card (e.g. "500 AI conversations / month").
 *
 * The tile note is either an author-written `entitlementNotes` entry ("Simultaneous
 * login allowed") or, failing that, the top-up offer for that metric derived from the
 * add-on catalog — so "₹1,000 → +1,500 contacts" is never typed twice.
 */
function buildHeadlineMetrics(plan, addOnPrices = {}) {
  const keys = Array.isArray(plan.headlineMetricKeys) ? plan.headlineMetricKeys : [];
  const notes = plan.entitlementNotes || {};

  const topUpNoteFor = (featureKey) => {
    const offer = Object.values(addOnPrices).find(
      (a) => a && a.grantAmount && a.grantFeatureKey === featureKey
    );
    if (!offer) return null;
    // A recurring per-seat add-on reads "+₹1,000/extra user"; a one-time pack reads
    // "₹1,000 → +1,500 contacts".
    if (offer.perUnitLabel) {
      return `+${formatRupees(offer.amountRupees)}/${offer.perUnitLabel}`;
    }
    const grant = Number(offer.grantAmount).toLocaleString('en-IN');
    return `${formatRupees(offer.amountRupees)} → +${grant}${offer.grantUnit ? ` ${offer.grantUnit}` : ''}`;
  };

  return keys.map((key) => {
    const catalogEntry = CATALOG_BY_KEY[key];
    if (!catalogEntry) return null;
    const resolved = resolvePlanFeature(plan, key);
    const value = catalogEntry.kind === 'limit'
      ? formatLimitDisplay(resolved?.limit)
      : renderCellValue(key, resolved);
    return {
      key,
      label: HEADLINE_METRIC_LABELS[key] || catalogEntry.label,
      value,
      unit: catalogEntry.unit || null,
      resetPeriod: catalogEntry.resetPeriod || null,
      note: notes[key] || topUpNoteFor(key)
    };
  }).filter(Boolean);
}

/**
 * Explicit bullet list from the plan's `cardBullets`, including excluded rows.
 * Falls back to the derived boolean bullets when an admin hasn't authored any.
 */
function buildCardBullets(plan) {
  const authored = Array.isArray(plan.cardBullets) ? plan.cardBullets : [];
  if (authored.length) {
    return authored.map((b) => ({
      label: b.label,
      included: b.included !== false,
      note: b.note || null,
      featureKey: b.featureKey || null
    }));
  }
  return CARD_FEATURE_KEYS
    .map((key) => buildFeatureBullet(plan, key))
    .filter(Boolean)
    .map((b) => ({ label: b.label, included: true, note: null, featureKey: b.key }));
}

// ── comparison matrix ───────────────────────────────────────────────────────

/** Render a resolved entitlement into the exact wording the sheet uses. */
function renderCellValue(featureKey, resolved) {
  const catalogEntry = CATALOG_BY_KEY[featureKey];
  if (!catalogEntry || !resolved) return EXCLUDED_CELL;

  switch (catalogEntry.kind) {
    case 'limit':
      return formatLimitDisplay(resolved.limit);
    case 'boolean':
      return resolved.enabled ? 'Yes' : EXCLUDED_CELL;
    case 'enum': {
      const map = ENUM_CELL_LABELS[featureKey] || {};
      return map[resolved.value] ?? titleCase(resolved.value);
    }
    case 'list': {
      const list = Array.isArray(resolved.value) ? resolved.value : [];
      if (!list.length) return EXCLUDED_CELL;
      return list.map((m) => CHANNEL_LABELS[m] || titleCase(m)).join(' + ');
    }
    default:
      return String(resolved.value ?? EXCLUDED_CELL);
  }
}

/** Is this resolved value an "off" state? Drives the greyed-out cell treatment. */
function isCellIncluded(featureKey, resolved) {
  const catalogEntry = CATALOG_BY_KEY[featureKey];
  if (!catalogEntry || !resolved) return false;
  switch (catalogEntry.kind) {
    case 'limit':
      return resolved.limit !== 0;
    case 'boolean':
      return !!resolved.enabled;
    case 'enum': {
      const opts = catalogEntry.enumOptions || [];
      return !(opts[0] === 'none' && resolved.value === 'none');
    }
    case 'list':
      return Array.isArray(resolved.value) && resolved.value.length > 0;
    default:
      return resolved.value != null;
  }
}

/**
 * Row formatters that need more than the raw entitlement — each returns a full cell.
 * Kept as named strings in the layout config so that file stays serialisable.
 */
const CELL_FORMATTERS = {
  /** "Included" rather than "Yes" — matches the sheet's wording for bundled AI. */
  includedFlag(plan, row, resolved) {
    const included = isCellIncluded(row.key, resolved);
    return { display: included ? 'Included' : EXCLUDED_CELL, included };
  },

  /** "Instagram + WhatsApp" style channel list. */
  channelList(plan, row, resolved) {
    return { display: renderCellValue(row.key, resolved), included: isCellIncluded(row.key, resolved) };
  },

  /** The WhatsApp row asks only whether WhatsApp is in the channel list. */
  whatsappAccess(plan, row, resolved) {
    const list = Array.isArray(resolved?.value) ? resolved.value : [];
    const has = list.includes('whatsapp');
    return { display: has ? 'Included' : EXCLUDED_CELL, included: has };
  },

  /** "Unlimited" or "Unlimited + AI-decisioned", depending on a second key. */
  automationsWithAiDecisioning(plan, row, resolved) {
    const base = formatLimitDisplay(resolved?.limit);
    const ai = resolvePlanFeature(plan, FEATURE_KEYS.AUTOMATION_AI_DECISIONING);
    const display = ai?.enabled ? `${base} + AI-decisioned` : base;
    return { display, included: resolved?.limit !== 0 };
  },

  /**
   * Flow Builder is three different things by tier: a paid non-AI add-on, a paid
   * AI add-on, or bundled free. The cell reads the plan's two flow-builder keys plus
   * the add-on price handed in by the caller.
   */
  flowBuilder(plan, row, resolved, ctx) {
    const bundled = !!resolved?.enabled;
    const ai = resolvePlanFeature(plan, FEATURE_KEYS.FLOW_BUILDER_AI_ENABLED)?.enabled;
    const suffix = ai ? 'AI-powered' : 'not AI-powered';
    if (bundled) return { display: `Included free — ${suffix}`, included: true };
    const price = ctx?.addOnPrices?.[row.addOnRef];
    const priceLabel = price ? formatRupees(price.amountRupees) : null;
    return {
      display: priceLabel ? `${priceLabel} add-on — ${suffix}` : `Add-on — ${suffix}`,
      included: false,
      isAddOn: true
    };
  },

  /** "₹1,000" — a flat per-unit add-on price. */
  addOnPrice(plan, row, resolved, ctx) {
    const price = ctx?.addOnPrices?.[row.addOnRef];
    if (!price) return { display: EXCLUDED_CELL, included: false };
    return { display: formatRupees(price.amountRupees), included: true, isAddOn: true };
  },

  /** "₹1,000 → +1,500 contacts" — price and the grant it buys on THIS plan. */
  addOnPriceForGrant(plan, row, resolved, ctx) {
    const price = ctx?.addOnPrices?.[row.addOnRef];
    if (!price) return { display: EXCLUDED_CELL, included: false };
    const grant = price.grantAmount ? `+${Number(price.grantAmount).toLocaleString('en-IN')}` : '';
    const unit = price.grantUnit ? ` ${price.grantUnit}` : '';
    return {
      display: `${formatRupees(price.amountRupees)} → ${grant}${unit}`.trim(),
      included: true,
      isAddOn: true
    };
  },

  /** "₹1,500 – ₹2,500" — a minimum/maximum top-up band. */
  addOnPriceRange(plan, row, resolved, ctx) {
    const price = ctx?.addOnPrices?.[row.addOnRef];
    if (!price) return { display: EXCLUDED_CELL, included: false };
    const { minRupees, maxRupees, amountRupees } = price;
    const display = minRupees && maxRupees
      ? `${formatRupees(minRupees)} – ${formatRupees(maxRupees)}`
      : formatRupees(amountRupees);
    return { display, included: true, isAddOn: true };
  }
};

function buildCell(plan, row, ctx) {
  const notes = plan.entitlementNotes || {};
  const note = row.key ? (notes[row.key] || null) : null;

  if (row.staticValue !== undefined) {
    return { display: row.staticValue, included: true, note };
  }

  const resolved = row.key ? resolvePlanFeature(plan, row.key) : null;
  const formatter = row.formatter ? CELL_FORMATTERS[row.formatter] : null;

  if (formatter) {
    return { ...formatter(plan, row, resolved, ctx), note };
  }

  if (!row.key) {
    return { display: EXCLUDED_CELL, included: false, note };
  }

  return {
    display: renderCellValue(row.key, resolved),
    included: isCellIncluded(row.key, resolved),
    note
  };
}

/**
 * The full comparison table: every section × every plan, nothing hidden.
 *
 * @param {Array} plans - plan documents, already in display order
 * @param {object} [ctx] - { addOnPrices: { [addOnId]: { amountRupees, grantAmount, grantUnit, minRupees, maxRupees } } }
 *                         keyed per plan id by the caller; see planController.getPricingPage.
 */
function buildComparisonMatrix(plans, ctx = {}) {
  const highlightedIndex = plans.findIndex((p) => p.cardStyle === 'dark');

  const sections = SECTIONS.map((section) => ({
    id: section.id,
    title: section.title,
    rows: section.rows.map((row) => {
      const catalogEntry = row.key ? CATALOG_BY_KEY[row.key] : null;
      return {
        label: row.label,
        metering: row.metering || catalogEntry?.metering || 'NAC',
        spansAllColumns: !!row.spansAllColumns,
        cells: row.spansAllColumns
          ? [{ ...buildCell(plans[0] || {}, row, ctx), highlighted: false }]
          : plans.map((plan, i) => ({
            ...buildCell(plan, row, { addOnPrices: (ctx.addOnPrices || {})[plan.planId] }),
            highlighted: i === highlightedIndex
          }))
      };
    })
  }));

  return {
    planColumns: plans.map((p, i) => ({
      planId: p.planId,
      name: p.name,
      highlighted: i === highlightedIndex
    })),
    sections
  };
}

// ── public card ─────────────────────────────────────────────────────────────

/**
 * Public plan card payload for GET /api/plans, /api/plans/pricing-page and
 * the (deprecated) subscription/plans endpoint.
 *
 * @param {object} plan
 * @param {object} [ctx] - { planNamesById } so "Everything in Starter" resolves to a name,
 *                         { addOnPrices } (for THIS plan) so metric tiles can show top-ups.
 */
function buildPublicPlanCard(plan, ctx = {}) {
  const highlights = CARD_LIMIT_KEYS.map((key) => buildHighlight(plan, key)).filter(Boolean);
  const features = CARD_FEATURE_KEYS.map((key) => buildFeatureBullet(plan, key)).filter(Boolean);
  const limits = buildLegacyLimitsFromPlan(plan);
  const planNamesById = ctx.planNamesById || {};

  return {
    planId: plan.planId,
    name: plan.name,
    tier: plan.tier,
    price: plan.price,
    description: plan.description || null,
    limits,
    highlights,
    features,
    badge: plan.badge || null,
    badgeColor: plan.badgeColor || null,
    billingCycle: plan.billingCycle || 'monthly',

    // ── pricing-sheet additions ──────────────────────────────────────────────
    tagline: plan.tagline || null,
    cardStyle: plan.cardStyle || 'light',
    inheritsFrom: plan.inheritsFromPlanId
      ? (planNamesById[plan.inheritsFromPlanId] || null)
      : null,
    limitedOffer: plan.limitedOffer?.active
      ? { badge: plan.limitedOffer.badge || plan.badge || null, endsAt: plan.limitedOffer.endsAt || null }
      : null,
    headline: buildHeadlineMetrics(plan, ctx.addOnPrices),
    bullets: buildCardBullets(plan),
    pricing: buildPricingBlock(plan),
    isCustomPrice: plan.price === 'custom'
  };
}

/** The WhatsApp pass-through panel that sits under the comparison table. */
function buildWhatsAppRatesPanel() {
  return {
    note: WHATSAPP_RATES_NOTE,
    rates: WHATSAPP_RATES_INR_PAISE.map((r) => ({
      category: r.category,
      label: r.label,
      display: r.display
    }))
  };
}

module.exports = {
  buildPublicPlanCard,
  buildComparisonMatrix,
  buildWhatsAppRatesPanel,
  buildPricingBlock,
  AC_NAC_LEGEND,
  CARD_LIMIT_KEYS,
  CARD_FEATURE_KEYS,
  // test hooks
  _renderCellValue: renderCellValue,
  _isCellIncluded: isCellIncluded
};
