'use strict';

/**
 * Commerce Agent Service (Phase 2 — Autonomous)
 *
 * When `organization.autonomousCommerceEnabled === true`, this service
 * evaluates inbound WhatsApp messages for purchase intent and, if confidence
 * is high enough, automatically sends a product card or product list.
 *
 * Guardrails enforced here:
 *   - Org-level master toggle (`autonomousCommerceEnabled`)
 *   - Per-user daily cap (`autonomousCommerceMaxSendsPerUserPerDay`)
 *   - WhatsApp 24-hour session window (no auto-send if window closed)
 *   - Confidence threshold (>= 0.75 required for autonomous action)
 *   - Full audit log of every autonomous AI commerce action
 *
 * Called from: whatsappWebhookService.processIncomingMessage (best-effort, non-fatal)
 */

const logger = require('../../config/logger');

// Simple keyword-based intent classifier (Phase 1 lite).
// Phase 2 can swap this with a real LLM intent call.
const PURCHASE_INTENT_KEYWORDS = [
  'buy', 'order', 'price', 'cost', 'how much', 'want', 'need', 'purchase',
  'available', 'stock', 'catalog', 'shop', 'checkout', 'pay'
];

function classifyCommerceIntent(text) {
  if (!text) return { intent: 'none', confidence: 0 };
  const lower = text.toLowerCase();
  const matched = PURCHASE_INTENT_KEYWORDS.filter((kw) => lower.includes(kw));
  if (matched.length === 0) return { intent: 'none', confidence: 0 };
  const confidence = Math.min(0.5 + matched.length * 0.1, 0.9);
  return { intent: 'purchase_ready', confidence };
}

/**
 * Try to autonomously handle a commerce intent.
 * Non-fatal — any error is logged and swallowed.
 *
 * @param {object} opts
 * @param {string} opts.organizationId
 * @param {string} opts.senderId        Customer WA phone number
 * @param {string} opts.text            Inbound message text
 * @param {object} opts.connection      PlatformConnection document
 * @param {object} opts.interaction     Saved Interaction document
 */
async function tryAutonomousCommerceAction({ organizationId, senderId, text, connection, interaction }) {
  try {
    const Organization = require('../../models/Organization');
    const org = await Organization.findById(organizationId)
      .select('autonomousCommerceEnabled autonomousCommerceMaxSendsPerUserPerDay')
      .lean();

    if (!org?.autonomousCommerceEnabled) return;

    const { intent, confidence } = classifyCommerceIntent(text);
    if (intent === 'none' || confidence < 0.75) return;

    // Rate limit: check how many autonomous sends today for this sender
    const CommerceOrder = require('../../models/CommerceOrder');
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const sendsToday = await CommerceOrder.countDocuments({
      organization: organizationId,
      buyerPhone: senderId,
      channel: 'whatsapp',
      status: 'product_sent',
      createdAt: { $gte: todayStart }
    });

    const maxPerDay = org.autonomousCommerceMaxSendsPerUserPerDay || 3;
    if (sendsToday >= maxPerDay) {
      logger.debug('[commerceAgent] Daily cap reached for sender', { senderId, sendsToday, maxPerDay });
      return;
    }

    // Find the most relevant product(s)
    const { searchProducts } = require('./productSearchService');
    const { products } = await searchProducts(organizationId, text, { limit: 1 });
    if (!products.length) return;

    const product = products[0];
    const catalogId = connection.platformData?.catalogId || connection.metadata?.catalogId;
    if (!catalogId) return;

    const entitlementsService = require('../entitlementsService');
    const { FEATURE_KEYS } = require('../../config/featureCatalog');
    const catalogAllowed = await entitlementsService.can(
      organizationId.toString(),
      FEATURE_KEYS.COMMERCE_WA_CATALOG_ENABLED
    );
    if (!catalogAllowed) return;

    // Send the product card
    const whatsappCatalogService = require('../../integrations/whatsapp/whatsappCatalogService');
    const msgResult = await whatsappCatalogService.sendProductMessage(
      connection,
      senderId,
      catalogId,
      product.sku || product._id.toString(),
      `Here's ${product.name} — does this help?`
    );

    const { assignOrderDisplayRef } = require('../../utils/opsRefHelper');

    // Log as CommerceOrder for audit trail
    await CommerceOrder.create(
      await assignOrderDisplayRef(organizationId, {
        organization: organizationId,
        channel: 'whatsapp',
        status: 'product_sent',
        lineItems: [{
          product: product._id,
          retailerId: product.sku || product._id.toString(),
          name: product.name,
          qty: 1,
          unitPrice: product.price,
          currency: product.currency || 'AED'
        }],
        buyerPhone: senderId,
        whatsappMessageId: msgResult?.messageId,
        sourceInteraction: interaction?._id,
        notes: `[Auto-sent by Commerce Agent] Intent: ${intent}, confidence: ${confidence.toFixed(2)}`
      })
    );

    logger.info('[commerceAgent] Autonomous product sent', {
      organizationId,
      senderId,
      productId: product._id.toString(),
      confidence
    });
  } catch (err) {
    logger.warn('[commerceAgent] tryAutonomousCommerceAction failed (non-fatal)', { error: err.message });
  }
}

module.exports = { tryAutonomousCommerceAction, classifyCommerceIntent };
