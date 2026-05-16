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
const SalesConversationState = require('../models/SalesConversationState');
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
        // Prefer the connection that was used to receive this webhook.
        // Also include metadata so we can use the ISUID for Instagram Login connections —
        // IGAA tokens are valid ONLY for /{ISUID}/... endpoints, not /{globalIgId}/...
        let conn = interaction.platformConnection
          ? await PlatformConnection.findById(interaction.platformConnection)
              .select('accessToken metadata').lean()
          : null;

        // If the interaction's connection has an expired/invalid token, or wasn't set,
        // fall back to the most recently updated (freshest) active connection.
        if (!conn?.accessToken) {
          conn = await PlatformConnection.findOne({
            organization: organizationId,
            platform: 'instagram',
            isActive: true,
            status: { $in: ['connected', 'available'] }
          }).sort({ updatedAt: -1 }).select('accessToken metadata').lean();
        }

        if (!conn?.accessToken) {
          svcLogger.warn('[commentToDm] Shortcode fallback skipped — no active Instagram connection found for org', { organizationId });
        } else {
          // For Instagram Login (IGAA tokens), the media endpoint requires the ISUID,
          // not the global IG business account ID stored in platformUserId.
          const isuid = conn.metadata?.igLoginScopedId;
          // Use GET /{mediaId}?fields=shortcode — this only needs a valid token, no user ID in path
          const resp = await axios.get(`https://graph.facebook.com/v18.0/${postId}`, {
            params: { fields: 'shortcode', access_token: conn.accessToken },
            timeout: 5000
          });
          const shortcode = resp.data?.shortcode;
          if (!shortcode) {
            svcLogger.warn('[commentToDm] Instagram Graph API returned no shortcode for postId', { postId, response: resp.data });
          } else {
            svcLogger.info('[commentToDm] Resolved numeric postId to shortcode — retrying product lookup', { postId, shortcode, isuid: isuid || 'n/a' });
            products = await Product.find({
              organization: organizationId,
              instagramPostIds: shortcode,
              isActive: true
            }).lean();

            // Backfill the numeric ID into the product so future lookups are instant (no API call needed)
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
        const errCode = resolveErr.response?.data?.error?.code;
        const errMsg = String(resolveErr.message || '');
        const isTokenError = errCode === 190 ||
          errMsg.toLowerCase().includes('token') ||
          errMsg.toLowerCase().includes('oauth') ||
          resolveErr.response?.status === 400;

        if (isTokenError) {
          svcLogger.warn(
            '[commentToDm] Shortcode resolution failed — Instagram access token is expired or invalid. ' +
            'Reconnect the Instagram account in Settings → Integrations, then click "Fix now" in Catalog → Automation to backfill post IDs.',
            { postId, errCode, err: resolveErr.message }
          );
        } else {
          svcLogger.warn('[commentToDm] Could not resolve numeric postId to shortcode', { postId, err: resolveErr.message });
        }
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

    // ── Per-product config: merge product.dmConfig over org salesFlowSettings ──
    // product.dmConfig fields win; org salesFlowSettings are the fallback default.
    // We do this here so both the public-reply stub and the CTA build can use it.
    const pdc = product.dmConfig || {};
    // sfSettings is populated at step 8 below; we capture a forward-reference now
    // so we can build the effective config once sfSettings is available.
    // Defer the merge to step 8 where sfSettings is loaded.

    svcLogger.info('[commentToDm] Product resolved', {
      interactionId,
      postId,
      productId: product._id,
      productName: product.name,
      hasPerProductDmConfig: !!(pdc.ctaButtons?.length || pdc.ctaTitle || pdc.triggerKeywords?.length)
    });

    const commenterId = interaction.author?.platformId;
    if (!commenterId) {
      svcLogger.warn('[commentToDm] Skipping — comment has no author.platformId (cannot DM)', { interactionId });
      return;
    }

    // ── 3b. Per-product trigger keyword override ───────────────────────
    // If the matched product has its own triggerKeywords, the comment must
    // also match those (acts as an AND filter on top of the global check).
    if (pdc.triggerKeywords?.length) {
      const productKws = pdc.triggerKeywords.map(k => k.toLowerCase().trim()).filter(Boolean);
      const productMatched = productKws.some(kw => commentText.includes(kw));
      if (!productMatched) {
        svcLogger.info('[commentToDm] Skipping — comment did not match per-product triggerKeywords', {
          productId: product._id, productKws, commentText: commentText.substring(0, 60)
        });
        return;
      }
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
    const orgDoc = await Organization.findById(organizationId).select('commentToDmSettings salesFlowSettings');
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
    const connType = connection.metadata?.connectionType
      || (typeof connection.accessToken === 'string' && connection.accessToken.startsWith('IGAA') ? 'instagram_login' : null);
    // For Instagram Login (IGAA tokens), use the app-scoped ISUID stored in
    // metadata.igLoginScopedId — NOT the self-healed global ID in platformPageId.
    const pageId = connType === 'instagram_login'
      ? (connection.metadata?.igLoginScopedId || connection.platformUserId)
      : (connection.platformData?.pageId || connection.platformPageId || connection.platformUserId);

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
      const stubResult = await instagramService.replyToComment(
        interaction.platformId,
        publicStub,
        accessToken,
        connType
      );
      if (stubResult?.success) {
        svcLogger.info('[commentToDm] Posted public comment stub', {
          commentId: interaction.platformId,
          stub: publicStub
        });
      } else {
        svcLogger.warn('[commentToDm] Public comment stub not posted — continuing to DM', {
          commentId: interaction.platformId,
          error: stubResult?.error || 'unknown'
        });
      }
    } catch (stubErr) {
      // Non-fatal — still send DM even if public reply fails (e.g. comment deleted, permissions)
      svcLogger.warn('[commentToDm] Failed to post public comment stub — continuing to DM', {
        commentId: interaction.platformId,
        error: stubErr.message
      });
    }

    // ── 8. Build effective DM config (product overrides org defaults) ──
    // salesFlowSettings were loaded alongside commentToDmSettings (orgDoc at ~step 5).
    const sfSettings = orgDoc.salesFlowSettings || {};

    /**
     * Effective config = per-product dmConfig fields (if set) over org salesFlowSettings.
     * ctaButtons: product array takes full priority (no partial merge) so the product
     * can have a completely different set of buttons.
     */
    const effectiveDmConfig = {
      ctaTitle:    pdc.ctaTitle    || sfSettings.ctaTitle    || '',
      ctaSubtitle: pdc.ctaSubtitle || sfSettings.ctaSubtitle || '',
      ctaImageUrl: pdc.ctaImageUrl || sfSettings.ctaImageUrl || '',
      ctaButtons:  (pdc.ctaButtons?.length ? pdc.ctaButtons : sfSettings.ctaButtons) || [],
      hesitancyKeywords:           (pdc.hesitancyKeywords?.length   ? pdc.hesitancyKeywords   : sfSettings.hesitancyKeywords)   || [],
      whatsappCaptureMessage:      pdc.whatsappCaptureMessage      || sfSettings.whatsappCaptureMessage      || '',
      whatsappCaptureConfirmation: pdc.whatsappCaptureConfirmation || sfSettings.whatsappCaptureConfirmation || '',
    };
    const useSalesFlow = sfSettings.enabled === true;

    // ── 9. Build order token and payment URL ──────────────────────────
    const orderToken = nanoid(24);
    const paymentUrlWithToken = product.paymentUrl
      ? `${product.paymentUrl}${product.paymentUrl.includes('?') ? '&' : '?'}ref=${orderToken}`
      : '';

    svcLogger.info('[commentToDm] Sending product DM', {
      commenterId,
      productId: product._id,
      orderToken,
      useSalesFlow
    });

    // ── 10. Build CTA buttons (postback or web_url) ──────────────────
    // Always send a CTA-only DM. Price / product details are revealed only after
    // the user taps a button or replies via the postback / typed-intent flow.
    const MAX_LABEL = 20;
    const MAX_TITLE = 80;
    const rawButtons = Array.isArray(effectiveDmConfig.ctaButtons) ? effectiveDmConfig.ctaButtons : [];
    const buttons = [];

    for (const btn of rawButtons) {
      if (buttons.length >= 3) break; // Instagram Generic Template hard limit
      const label = String(btn.label || '').trim();
      if (!label) continue;
      const type = btn.type === 'web_url' ? 'web_url' : 'postback';

      if (type === 'web_url') {
        let url = String(btn.url || '').replace(/\{\{orderToken\}\}/g, orderToken).trim();
        // Convenience: empty Pay Now URL falls back to product paymentUrl with token
        if (!url && /pay/i.test(label) && paymentUrlWithToken) url = paymentUrlWithToken;
        if (!/^https:\/\//i.test(url)) continue;
        buttons.push({ type: 'web_url', url, title: label.slice(0, MAX_LABEL) });
      } else {
        const payload = String(btn.payload || '').trim() || label.toLowerCase();
        // Embed orderToken in the payload so the postback handler can correlate
        // the click back to the exact ProductOrder/SalesConversationState row.
        buttons.push({
          type: 'postback',
          title: label.slice(0, MAX_LABEL),
          payload: `SALES:${payload}:${orderToken}`
        });
      }
    }

    let dmSendMethod = 'cta_template';

    if (buttons.length > 0) {
      const element = {
        title: String(effectiveDmConfig.ctaTitle || `🛍️ ${product.name}`).slice(0, MAX_TITLE),
        buttons
      };
      const subtitle = String(effectiveDmConfig.ctaSubtitle || 'Tap a button below to continue 👇').slice(0, MAX_TITLE);
      if (subtitle) element.subtitle = subtitle;
      const imgUrl = String(effectiveDmConfig.ctaImageUrl || product.imageUrl || '').trim();
      if (imgUrl && /^https:\/\//i.test(imgUrl)) element.image_url = imgUrl;

      try {
        await instagramService.sendPrivateReplyGenericTemplate(
          interaction.platformId, element, accessToken, pageId, connType
        );
      } catch (gtErr) {
        // Generic Template failed — fall back to a SHORT teaser text. We deliberately
        // do NOT reveal price or product details here; the user will get them after
        // they reply (handled by salesConversationService).
        svcLogger.warn('[commentToDm] sendPrivateReplyGenericTemplate failed — falling back to short teaser DM', {
          commentId: interaction.platformId, error: gtErr.message
        });
        dmSendMethod = 'cta_text_fallback';
        const teaser = `Hi${commenterUsername ? ' @' + commenterUsername : ''}! 👋 Thanks for your interest.\n\nReply with "details" for more info, or "buy" to order. 🛍️`;
        try {
          await instagramService.sendPrivateReply(interaction.platformId, teaser, accessToken, pageId, connType);
        } catch (prErr) {
          await instagramService.sendMessage(String(commenterId), teaser, accessToken, pageId, false, connType);
        }
      }
    } else {
      // No valid buttons configured — send a minimal teaser so the user can reply
      // and trigger the typed-intent flow. Still no price / product template.
      svcLogger.warn('[commentToDm] No valid CTA buttons configured — sending short teaser DM', { organizationId });
      dmSendMethod = 'cta_text_no_buttons';
      const teaser = `Hi${commenterUsername ? ' @' + commenterUsername : ''}! 👋 Thanks for your interest.\n\nReply with "details" for more info, or "buy" to order. 🛍️`;
      try {
        await instagramService.sendPrivateReply(interaction.platformId, teaser, accessToken, pageId, connType);
      } catch (prErr) {
        svcLogger.warn('[commentToDm] sendPrivateReply failed — falling back to sendMessage', {
          commentId: interaction.platformId, error: prErr.message
        });
        await instagramService.sendMessage(String(commenterId), teaser, accessToken, pageId, false, connType);
      }
    }

    svcLogger.info('[commentToDm] Product DM sent successfully', { commenterId, productId: product._id, dmSendMethod });

    // ── 11. Record the order ──────────────────────────────────────────
    const productOrder = await ProductOrder.create({
      organization: organizationId,
      product: product._id,
      instagramUserId: String(commenterId),
      instagramPostId: String(postId),
      commentInteractionId: interaction._id,
      orderToken,
      status: 'dm_sent'
    });

    // ── 12. Record sales conversation state ───────────────────────────
    // Always upsert state so both postback clicks and typed replies have a row
    // to advance. The state machine is invariant to salesFlowSettings.enabled —
    // that flag now only controls hesitancy detection on typed replies.
    try {
      await SalesConversationState.findOneAndUpdate(
        { organization: organizationId, instagramUserId: String(commenterId), postId: String(postId) },
        {
          $set: {
            productOrderId: productOrder._id,
            stage: 'initial_cta_sent',
            lastStageAt: new Date(),
            whatsappNumber: null
          }
        },
        { upsert: true, new: true }
      );
      svcLogger.info('[commentToDm] SalesConversationState upserted', {
        commenterId, postId, stage: 'initial_cta_sent'
      });
    } catch (stateErr) {
      // Non-fatal: DM was already sent; log and continue
      svcLogger.warn('[commentToDm] Failed to upsert SalesConversationState', { error: stateErr.message });
    }

    // ── 13. Increment daily counter ───────────────────────────────────
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
