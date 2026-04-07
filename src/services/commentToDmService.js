/**
 * Instagram Comment-to-DM Selling Orchestrator
 *
 * Flow:
 *  1. Comment arrives on an Instagram post.
 *  2. We check the org's commentToDmSettings — if enabled and the comment contains
 *     a buy-intent keyword.
 *  3. We look up products linked to the post's media ID.
 *  4. Deduplication: if we already sent a DM to this user for this post, skip.
 *  5. Daily rate limit check.
 *  6. Post a safe public-stub reply to the comment (no payment link).
 *  7. Send a product DM privately.
 *  8. Record a ProductOrder for deduplication and payment correlation.
 */

const Organization = require('../models/Organization');
const Product = require('../models/Product');
const ProductOrder = require('../models/ProductOrder');
const PlatformConnection = require('../models/PlatformConnection');
const instagramService = require('../integrations/meta/instagramService');
const logger = require('../config/logger');
const { nanoid } = require('nanoid');

const svcLogger = logger.createChild({ module: 'commentToDmService' });

/**
 * Entry point — call this after an Instagram comment interaction is saved.
 *
 * @param {import('../models/Interaction').default} interaction - newly-saved Interaction doc
 * @param {string} organizationId
 */
async function processCommentForProduct(interaction, organizationId) {
  try {
    if (!interaction || interaction.platform !== 'instagram' || interaction.type !== 'comment') {
      return;
    }

    // ── 1. Load org settings ───────────────────────────────────────────
    const org = await Organization.findById(organizationId)
      .select('commentToDmSettings')
      .lean();

    if (!org?.commentToDmSettings?.enabled) return;

    const settings = org.commentToDmSettings;

    // ── 2. Buy-intent keyword check ────────────────────────────────────
    const commentText = (interaction.content || '').toLowerCase();
    const keywords = (settings.triggerKeywords || []).map(k => k.toLowerCase().trim()).filter(Boolean);
    const matched = keywords.some(kw => commentText.includes(kw));
    if (!matched) return;

    svcLogger.info('Comment matched buy-intent keyword', {
      interactionId: interaction._id,
      commentPreview: commentText.substring(0, 60)
    });

    // ── 3. Resolve post → product(s) ──────────────────────────────────
    const postId = interaction.metadata?.postId;
    if (!postId) {
      svcLogger.debug('No postId on interaction — cannot map to product', { interactionId: interaction._id });
      return;
    }

    const products = await Product.find({
      organization: organizationId,
      instagramPostIds: String(postId),
      isActive: true
    }).lean();

    if (!products.length) {
      svcLogger.debug('No products linked to post', { postId, organizationId });
      return;
    }

    const product = products[0]; // Use the first mapped product; extend later for multi-product posts

    const commenterId = interaction.author?.platformId;
    if (!commenterId) {
      svcLogger.warn('Comment has no author.platformId — cannot DM', { interactionId: interaction._id });
      return;
    }

    // ── 4. Deduplication ───────────────────────────────────────────────
    if (settings.deduplicateDms !== false) {
      const alreadySent = await ProductOrder.exists({
        organization: organizationId,
        instagramUserId: String(commenterId),
        instagramPostId: String(postId)
      });
      if (alreadySent) {
        svcLogger.info('DM already sent to this user for this post — skipping dedup', { commenterId, postId });
        return;
      }
    }

    // ── 5. Daily rate limit ────────────────────────────────────────────
    const orgDoc = await Organization.findById(organizationId).select('commentToDmSettings');
    const today = new Date().toDateString();
    const resetDate = orgDoc.commentToDmSettings.dmsSentResetDate
      ? new Date(orgDoc.commentToDmSettings.dmsSentResetDate).toDateString()
      : null;

    if (resetDate !== today) {
      orgDoc.commentToDmSettings.dmsSentToday = 0;
      orgDoc.commentToDmSettings.dmsSentResetDate = new Date();
    }

    if (orgDoc.commentToDmSettings.dmsSentToday >= (orgDoc.commentToDmSettings.maxDmsPerDay || 200)) {
      svcLogger.warn('Daily DM limit reached — skipping', {
        dmsSentToday: orgDoc.commentToDmSettings.dmsSentToday,
        limit: orgDoc.commentToDmSettings.maxDmsPerDay
      });
      return;
    }

    // ── 6. Resolve platform connection ────────────────────────────────
    const connection = interaction.platformConnection
      ? await PlatformConnection.findById(interaction.platformConnection).select('accessToken platformData platformPageId platformUserId').lean()
      : await PlatformConnection.findOne({
          organization: organizationId,
          platform: 'instagram',
          isActive: true
        }).select('accessToken platformData platformPageId platformUserId').lean();

    if (!connection) {
      svcLogger.warn('No Instagram platform connection found', { organizationId });
      return;
    }

    const accessToken = connection.accessToken;
    const pageId = connection.platformData?.pageId || connection.platformPageId || connection.platformUserId;

    // ── 7. Post safe public-comment stub ──────────────────────────────
    const commenterUsername = interaction.author?.username || '';
    // GUARDRAIL: strip any payment_url or payment-sensitive tokens from the public template
    // so a misconfigured template can never expose a payment link in a public comment.
    const safePublicTemplate = (settings.publicReplyTemplate || "Hi {{username}}! 👋 We've sent you the details in DM. 😊")
      .replace(/\{\{payment_url\}\}/gi, '')
      .replace(/\{\{paymentUrl\}\}/gi, '');

    const publicStub = buildTemplate(safePublicTemplate, {
      username: commenterUsername ? `@${commenterUsername}` : 'there'
    });

    try {
      await instagramService.replyToComment(interaction.platformId, publicStub, accessToken);
      svcLogger.info('Posted public comment stub', { commentId: interaction.platformId });
    } catch (stubErr) {
      // Don't abort — still send DM even if public reply fails (e.g. comment deleted)
      svcLogger.warn('Failed to post public comment stub', { error: stubErr.message });
    }

    // ── 8. Build order token and DM ───────────────────────────────────
    const orderToken = nanoid(24);
    const paymentUrlWithToken = product.paymentUrl
      ? `${product.paymentUrl}${product.paymentUrl.includes('?') ? '&' : '?'}ref=${orderToken}`
      : '';

    const dmText = buildTemplate(
      settings.dmTemplate ||
        'Hi {{username}}! 👋 Thanks for your interest.\n\n🛍️ *{{product_name}}*\n💵 Price: {{currency}} {{price}}\n\n👉 Order here: {{payment_url}}\n\nFeel free to DM us if you have any questions! 😊',
      {
        username: commenterUsername || 'there',
        product_name: product.name,
        description: product.description || '',
        price: String(product.price),
        currency: product.currency || 'AED',
        sizes: product.sizes?.join(', ') || 'N/A',
        colors: product.colors?.join(', ') || 'N/A',
        payment_url: paymentUrlWithToken || product.paymentUrl || '(link coming soon)'
      }
    );

    await instagramService.sendMessage(String(commenterId), dmText, accessToken, pageId, false);
    svcLogger.info('Sent product DM', { commenterId, productId: product._id });

    // ── 9. Record the order ───────────────────────────────────────────
    await ProductOrder.create({
      organization: organizationId,
      product: product._id,
      instagramUserId: String(commenterId),
      instagramPostId: String(postId),
      commentInteractionId: interaction._id,
      orderToken,
      status: 'dm_sent'
    });

    // ── 10. Increment daily counter ───────────────────────────────────
    orgDoc.commentToDmSettings.dmsSentToday += 1;
    await orgDoc.save();

    svcLogger.info('Comment-to-DM flow completed', {
      commenterId,
      productId: product._id,
      postId,
      orderToken
    });
  } catch (err) {
    // Never throw — this service runs as a side effect of the webhook and must not break it
    svcLogger.error('commentToDmService error', { error: err.message, stack: err.stack });
  }
}

/**
 * Simple Mustache-style template filler.
 * Replaces {{key}} tokens with values.
 */
function buildTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : `{{${key}}}`
  );
}

module.exports = { processCommentForProduct, buildTemplate };
