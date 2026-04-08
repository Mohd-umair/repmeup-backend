/**
 * Instagram Comment-to-DM Selling Orchestrator
 *
 * Flow:
 *  1. Comment arrives on an Instagram post.
 *  2. We check the org's commentToDmSettings — if enabled and the comment contains
 *     a buy-intent keyword.
 *  3. We look up products linked to the post's media ID (falls back to defaultProductId).
 *  4. Deduplication: if we already sent a DM to this user for this post, skip.
 *  5. Daily rate limit check.
 *  6. Post a safe public-stub reply to the comment (no payment link).
 *  7. Send a product DM privately.
 *  8. Record a ProductOrder for deduplication and payment correlation.
 */

const axios = require('axios');
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
 * @param {object} interaction - newly-saved Interaction doc (or plain object)
 * @param {string} organizationId
 */
async function processCommentForProduct(interaction, organizationId) {
  try {
    if (!interaction || interaction.platform !== 'instagram' || interaction.type !== 'comment') {
      return;
    }

    const interactionId = interaction._id?.toString?.() || 'unknown';

    // ── 1. Load org settings ───────────────────────────────────────────
    const org = await Organization.findById(organizationId)
      .select('commentToDmSettings')
      .lean();

    svcLogger.info('[commentToDm] Evaluating comment', {
      interactionId,
      commentPreview: (interaction.content || '').substring(0, 80),
      enabled: org?.commentToDmSettings?.enabled ?? false,
      postId: interaction.metadata?.postId ?? null
    });

    if (!org?.commentToDmSettings?.enabled) {
      svcLogger.info('[commentToDm] Skipping — automation is disabled for this org', { organizationId });
      return;
    }

    const settings = org.commentToDmSettings;

    // ── 2. Buy-intent keyword check ────────────────────────────────────
    const commentText = (interaction.content || '').toLowerCase();
    const keywords = (settings.triggerKeywords || []).map(k => k.toLowerCase().trim()).filter(Boolean);
    const matched = keywords.some(kw => commentText.includes(kw));

    svcLogger.info('[commentToDm] Keyword check', {
      interactionId,
      commentText: commentText.substring(0, 80),
      keywords,
      matched
    });

    if (!matched) {
      svcLogger.info('[commentToDm] Skipping — no trigger keyword matched', { commentText: commentText.substring(0, 60) });
      return;
    }

    // ── 3. Resolve post → product(s) ──────────────────────────────────
    const postId = interaction.metadata?.postId;

    if (!postId) {
      svcLogger.info('[commentToDm] Skipping — interaction has no metadata.postId (Instagram webhook did not include media.id)', {
        interactionId,
        platform: interaction.platform,
        platformId: interaction.platformId
      });
      return;
    }

    let products = await Product.find({
      organization: organizationId,
      instagramPostIds: String(postId),
      isActive: true
    }).lean();

    // ── Shortcode fallback ─────────────────────────────────────────────
    // The webhook delivers a numeric media ID (e.g. "17881020939515532") but the
    // user may have stored the URL shortcode (e.g. "DWlBp0ZgG2C"). Fetch the
    // shortcode from the Instagram Graph API and retry the lookup.
    if (!products.length && /^\d+$/.test(String(postId))) {
      try {
        const conn = await PlatformConnection.findOne({
          organization: organizationId,
          platform: 'instagram',
          status: 'connected'
        }).select('accessToken').lean();

        if (!conn?.accessToken) {
          svcLogger.warn('[commentToDm] Shortcode fallback skipped — no connected Instagram account found for org', { organizationId });
        } else {
          const resp = await axios.get(`https://graph.facebook.com/v18.0/${postId}`, {
            params: { fields: 'shortcode', access_token: conn.accessToken },
            timeout: 5000
          });
          const shortcode = resp.data?.shortcode;
          if (!shortcode) {
            svcLogger.warn('[commentToDm] Instagram Graph API returned no shortcode for postId', { postId, response: resp.data });
          } else {
            svcLogger.info('[commentToDm] Resolved numeric postId to shortcode — retrying product lookup', { postId, shortcode });
            products = await Product.find({
              organization: organizationId,
              instagramPostIds: shortcode,
              isActive: true
            }).lean();

            // Also backfill the numeric ID into the product so future lookups are instant
            if (products.length) {
              await Product.updateMany(
                { _id: { $in: products.map(p => p._id) } },
                { $addToSet: { instagramPostIds: String(postId) } }
              );
              svcLogger.info('[commentToDm] Backfilled numeric postId into product instagramPostIds', { postId, shortcode });
            }
          }
        }
      } catch (resolveErr) {
        svcLogger.warn('[commentToDm] Could not resolve numeric postId to shortcode', { postId, err: resolveErr.message });
      }
    }

    // Fallback: use defaultProductId if no product is linked to this specific post
    if (!products.length && settings.defaultProductId) {
      svcLogger.info('[commentToDm] No product linked to post — trying defaultProductId fallback', {
        postId,
        defaultProductId: settings.defaultProductId
      });
      const defaultProduct = await Product.findOne({
        _id: settings.defaultProductId,
        organization: organizationId,
        isActive: true
      }).lean();
      if (defaultProduct) products = [defaultProduct];
    }

    if (!products.length) {
      svcLogger.info('[commentToDm] Skipping — no product is linked to postId and no defaultProductId is set', {
        postId,
        organizationId
      });
      return;
    }

    const product = products[0];

    svcLogger.info('[commentToDm] Product resolved', {
      interactionId,
      postId,
      productId: product._id,
      productName: product.name
    });

    const commenterId = interaction.author?.platformId;
    if (!commenterId) {
      svcLogger.warn('[commentToDm] Skipping — comment has no author.platformId (cannot DM)', { interactionId });
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
        svcLogger.info('[commentToDm] Skipping — deduplication: DM already sent to this user for this post', {
          commenterId,
          postId
        });
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

    const maxDms = orgDoc.commentToDmSettings.maxDmsPerDay || 200;
    if (orgDoc.commentToDmSettings.dmsSentToday >= maxDms) {
      svcLogger.warn('[commentToDm] Skipping — daily DM limit reached', {
        dmsSentToday: orgDoc.commentToDmSettings.dmsSentToday,
        limit: maxDms
      });
      return;
    }

    // ── 6. Resolve platform connection ────────────────────────────────
    const connection = interaction.platformConnection
      ? await PlatformConnection.findById(interaction.platformConnection)
          .select('accessToken platformData platformPageId platformUserId').lean()
      : await PlatformConnection.findOne({
          organization: organizationId,
          platform: 'instagram',
          isActive: true
        }).select('accessToken platformData platformPageId platformUserId').lean();

    if (!connection) {
      svcLogger.warn('[commentToDm] Skipping — no active Instagram platform connection found', { organizationId });
      return;
    }

    const accessToken = connection.accessToken;
    const pageId = connection.platformData?.pageId || connection.platformPageId || connection.platformUserId;

    // ── 7. Post safe public-comment stub ──────────────────────────────
    const commenterUsername = interaction.author?.username || '';

    // GUARDRAIL: strip payment_url from the public template — never expose payment links in public comments
    const safePublicTemplate = (settings.publicReplyTemplate || "Hi {{username}}! 👋 We've sent you the details in DM. 😊")
      .replace(/\{\{payment_url\}\}/gi, '')
      .replace(/\{\{paymentUrl\}\}/gi, '');

    const publicStub = buildTemplate(safePublicTemplate, {
      username: commenterUsername ? `@${commenterUsername}` : 'there'
    });

    try {
      await instagramService.replyToComment(interaction.platformId, publicStub, accessToken);
      svcLogger.info('[commentToDm] Posted public comment stub', { commentId: interaction.platformId, stub: publicStub });
    } catch (stubErr) {
      // Non-fatal — still send DM even if public reply fails (e.g. comment deleted, permissions)
      svcLogger.warn('[commentToDm] Failed to post public comment stub — continuing to DM', {
        commentId: interaction.platformId,
        error: stubErr.message
      });
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

    svcLogger.info('[commentToDm] Sending product DM', {
      commenterId,
      productId: product._id,
      orderToken,
      dmPreview: dmText.substring(0, 100)
    });

    // ── Send DM via Private Reply (uses comment_id — no 24-hour window) ──
    // Falls back to the regular sendMessage if private reply fails (e.g. comment
    // is older than 7 days, or the private reply was already sent for this comment).
    let dmSendMethod = 'private_reply';
    try {
      await instagramService.sendPrivateReply(interaction.platformId, dmText, accessToken, pageId);
    } catch (privateReplyErr) {
      svcLogger.warn('[commentToDm] sendPrivateReply failed — falling back to sendMessage', {
        commentId: interaction.platformId,
        commenterId,
        error: privateReplyErr.message
      });
      dmSendMethod = 'send_message_fallback';
      await instagramService.sendMessage(String(commenterId), dmText, accessToken, pageId, false);
    }
    svcLogger.info('[commentToDm] Product DM sent successfully', { commenterId, productId: product._id, dmSendMethod });

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

    svcLogger.info('[commentToDm] Flow completed successfully', {
      commenterId,
      productId: product._id,
      postId,
      orderToken,
      dmsSentToday: orgDoc.commentToDmSettings.dmsSentToday
    });
  } catch (err) {
    // Never rethrow — this service runs as a side effect of the webhook and must not break it
    svcLogger.error('[commentToDm] Unhandled error', { error: err.message, stack: err.stack });
  }
}

/**
 * Simple Mustache-style template filler.
 * Replaces {{key}} tokens with values from vars.
 */
function buildTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : `{{${key}}}`
  );
}

module.exports = { processCommentForProduct, buildTemplate };
