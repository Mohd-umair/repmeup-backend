const { sendTextForInteraction } = require('../flowMessageService');
const Organization = require('../../../models/Organization');
const logger = require('../../../config/logger');
const flowTemplateService = require('../flowTemplateService');

const TRUE_BRANCHES = ['yes', 'true', 'match', 'matched'];
const FALSE_BRANCHES = ['no', 'false', 'nomatch', 'unmatched', 'else', 'default'];

/** Quick-reply button titles that must never be mistaken for a typed address. */
const BUTTON_TITLE_BLOCKLIST = new Set([
  'yes', 'no', 'yes ship here', 'new address', 'use a new address',
  'confirm', 'cancel', 'ship here', 'correct', 'use new address'
]);

/**
 * Heuristic guard: is this free text plausibly a delivery address — and NOT a
 * quick-reply button title (e.g. "✅ Yes, ship here") or other non-address reply?
 * Real addresses almost always carry a house number or pincode; button titles do not.
 */
function isLikelyAddress(text) {
  const raw = String(text || '').trim();
  if (raw.length < 8) return false;
  // Normalise: drop emoji/punctuation (keep word chars + spaces), collapse spaces.
  const norm = raw.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (BUTTON_TITLE_BLOCKLIST.has(norm)) return false;
  const words = raw.split(/\s+/).filter(Boolean).length;
  const hasDigit = /\d/.test(raw);
  if (hasDigit && words >= 2) return true;                        // house no / pincode present
  if (!hasDigit && words >= 5 && /[,\n]/.test(raw)) return true;  // long descriptive address
  return false;
}

/** Normalize an edge's branch label for comparison. */
function edgeBranch(edge) {
  return String(edge?.label || edge?.condition?.branch || '').trim().toLowerCase();
}

/**
 * Pick the outgoing edge. When `preferLabel` is given, prefer an edge whose
 * branch matches; otherwise fall back to the first unlabeled/default edge.
 */
/**
 * Plan gate for the AI nodes inside a flow.
 *
 * Flows execute in the `processFlowTick` worker, so there is nobody to return a 403 to.
 * Instead an unentitled AI node behaves exactly like an AI node that failed — which this
 * file already handles everywhere: continue down the default edge with a warning. The
 * enrolment keeps moving rather than wedging on a capability the org did not buy.
 *
 * Two keys, two meanings:
 *   flowBuilder.ai.enabled        — may a flow use AI at all
 *   automation.aiDecisioning.enabled — may AI decide which branch the flow takes
 * Decision nodes need both; a plain AI reply needs only the first.
 */
async function aiNodeEntitlement(organizationId, { decisioning = false } = {}) {
  if (!organizationId) return { allowed: true };
  try {
    const entitlementsService = require('../../entitlementsService');
    const { FEATURE_KEYS } = require('../../../config/featureCatalog');
    const orgId = String(organizationId);

    if (!(await entitlementsService.can(orgId, FEATURE_KEYS.FLOW_BUILDER_AI_ENABLED))) {
      return { allowed: false, reason: 'AI in Flow Builder is not included on this plan.' };
    }
    if (decisioning
        && !(await entitlementsService.can(orgId, FEATURE_KEYS.AUTOMATION_AI_DECISIONING))) {
      return { allowed: false, reason: 'AI-decisioned automations are not included on this plan.' };
    }
    return { allowed: true };
  } catch (err) {
    // An entitlement lookup failure must not silently disable a paid feature.
    logger.warn('[FlowHandler] AI entitlement check failed — allowing node', { error: err.message });
    return { allowed: true };
  }
}

function pickEdge(edges, preferLabel) {
  if (!edges?.length) return null;
  if (preferLabel) {
    const wanted = String(preferLabel).trim().toLowerCase();
    const labeled = edges.find((e) => edgeBranch(e) === wanted);
    if (labeled) return labeled;
  }
  return edges[0];
}

/**
 * Build WhatsApp template body components from a flat variables map.
 * { "1": "Sam", "2": "₹999" } → [{ type:'body', parameters:[{type:'text',text:'Sam'}, ...] }]
 */
function buildTemplateComponents(variables) {
  if (!variables || typeof variables !== 'object') return [];
  const keys = Object.keys(variables).sort((a, b) => Number(a) - Number(b));
  if (!keys.length) return [];
  return [{
    type: 'body',
    parameters: keys.map((k) => ({ type: 'text', text: String(variables[k]) }))
  }];
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Parse "HH:mm" into minutes since midnight; returns null if invalid. */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * True when "now" (in the configured IANA timezone) falls within the
 * business-hours window and on an allowed weekday. Handles overnight windows.
 */
function isWithinBusinessHours(config = {}) {
  const tz = config.timezone || 'Asia/Kolkata';
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
  }
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekday = String(get('weekday') || '').toLowerCase().slice(0, 3);
  const nowMin = Number(get('hour')) * 60 + Number(get('minute'));

  const days = Array.isArray(config.days) && config.days.length
    ? config.days.map((d) => String(d).toLowerCase().slice(0, 3))
    : DAY_KEYS.slice(1, 6); // Mon–Fri default
  if (!days.includes(weekday)) return false;

  const start = toMinutes(config.start) ?? 9 * 60;
  const end = toMinutes(config.end) ?? 18 * 60;
  if (start <= end) return nowMin >= start && nowMin < end;
  // Overnight window (e.g. 22:00–06:00)
  return nowMin >= start || nowMin < end;
}

/**
 * Seconds remaining until the flow's quiet-hours window ends.
 * Returns 0 when "now" (in the flow timezone) is outside quiet hours.
 * Handles overnight windows (e.g. 22:00 → 08:00).
 *
 * @param {object} settings  flow.settings ({ quietHoursStart, quietHoursEnd, timezone })
 * @returns {number} seconds to wait (0 = continue now)
 */
function secondsUntilQuietHoursEnd(settings = {}) {
  const start = toMinutes(settings.quietHoursStart);
  const end = toMinutes(settings.quietHoursEnd);
  if (start == null || end == null || start === end) return 0; // not configured

  const tz = settings.timezone || 'Asia/Kolkata';
  let nowMin;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value;
    nowMin = Number(get('hour')) * 60 + Number(get('minute'));
  } catch {
    const d = new Date();
    nowMin = d.getHours() * 60 + d.getMinutes();
  }

  const inWindow = start <= end
    ? (nowMin >= start && nowMin < end)
    : (nowMin >= start || nowMin < end); // overnight
  if (!inWindow) return 0;

  // Minutes until `end` (accounting for overnight wrap).
  let minsLeft = end - nowMin;
  if (minsLeft <= 0) minsLeft += 24 * 60;
  return minsLeft * 60;
}

/**
 * Per-contact, per-node daily rate-limit gate.
 *
 * Returns `true` (take the "yes"/continue branch) while the contact is under the
 * configured `maxPerDay` for this flow node, and increments the counter. Returns
 * `false` once the cap is hit. Backed by Redis with a 25h TTL; **fails open**
 * (returns true) if Redis is unavailable so a cache outage never blocks
 * customer messaging.
 *
 * @param {object} ctx   handler context (organizationId, flow, enrollment, node)
 * @param {object} config  node config ({ maxPerDay })
 * @returns {Promise<boolean>}
 */
async function checkRateLimit(ctx, config) {
  const max = Number(config?.maxPerDay);
  if (!Number.isFinite(max) || max <= 0) return true; // no cap configured

  const contactId = ctx.enrollment?.platformUserId
    || ctx.interaction?.author?.platformId
    || '';
  if (!contactId) return true; // can't identify contact → don't block

  try {
    const { getRedisClient } = require('../../../config/redis');
    const redis = getRedisClient();
    if (!redis) return true;

    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const flowId = ctx.flow?._id || ctx.flow?.id || 'flow';
    const nodeId = ctx.node?.id || 'node';
    const key = `flow:ratelimit:${ctx.organizationId}:${flowId}:${nodeId}:${contactId}:${day}`;

    const count = await redis.incrBy(key, 1);
    if (count === 1) {
      // First hit today — expire shortly after the day rolls over (25h).
      await redis.expire(key, 25 * 60 * 60);
    }
    return count <= max;
  } catch (err) {
    logger.warn('[FlowHandler] dedup_rate_limit check failed (fail-open)', { error: err.message });
    return true;
  }
}

/**
 * Resolve a true/false condition to the correct outgoing edge.
 * Honors yes/no (and synonyms) labels; falls back to first/second edge by order.
 */
function pickBranchEdge(edges, matched) {
  if (!edges?.length) return null;
  const wanted = matched ? TRUE_BRANCHES : FALSE_BRANCHES;
  const labeled = edges.find((e) => wanted.includes(edgeBranch(e)));
  if (labeled) return labeled;

  // No explicit labels — preserve legacy ordering: first edge = true, second = false.
  const unlabeled = edges.filter((e) => !edgeBranch(e));
  if (matched) return unlabeled[0] || edges[0];
  return unlabeled[1] || unlabeled[0] || edges[1] || edges[0];
}

/**
 * Resolve a product (by id or sku) to the retailer id WhatsApp expects.
 * Prefers SKU, falls back to the document id.
 */
async function resolveProductRetailerId(organizationId, productId) {
  const Product = require('../../../models/Product');
  const product = await Product.findOne({ _id: productId, organization: organizationId })
    .select('sku isActive')
    .lean();
  if (!product) return null;
  return (product.sku && String(product.sku).trim()) || String(product._id);
}

/**
 * Execute the WhatsApp interactive message actions (media, location, list,
 * buttons, single/multi product). Records the send on the inbox interaction
 * when possible. Throws on hard failures so the node is marked failed.
 */
async function handleWhatsAppInteractive(node, ctx) {
  // Interpolate {{tokens}} in all user-visible copy before sending.
  const tplContext = flowTemplateService.buildContext(ctx.interaction, ctx.enrollment?.variables);
  const render = (v) => (typeof v === 'string' ? flowTemplateService.render(v, { context: tplContext }) : v);
  const config = { ...(node.config || {}) };
  for (const key of ['bodyText', 'headerText', 'footerText', 'caption', 'buttonText', 'name', 'address']) {
    if (typeof config[key] === 'string') config[key] = render(config[key]);
  }
  const { organizationId, interaction, enrollment } = ctx;
  const messageService = require('../flowMessageService');
  const whatsappService = require('../../../integrations/whatsapp/whatsappService');
  const { recordAutomationReply } = require('../../inbox/inboxAutomationReplyService');

  const { conn, recipient } = await messageService.resolveWhatsAppTarget(organizationId, interaction, enrollment);
  if (!conn) {
    const fatalErr = new Error('WhatsApp is not connected. Connect WhatsApp in Settings → Platforms before using messaging actions.');
    fatalErr.fatal = true;
    throw fatalErr;
  }
  if (!recipient) {
    const fatalErr = new Error(`Cannot send WhatsApp message (${node.type}): contact has no WhatsApp ID.`);
    fatalErr.fatal = true;
    throw fatalErr;
  }

  const record = (content, messageType, attachment = null) => {
    if (!interaction?._id) return Promise.resolve();
    return recordAutomationReply({
      interactionId: interaction._id,
      organizationId,
      content,
      messageType,
      attachmentUrl: attachment?.url || null,
      attachmentType: attachment?.type || null
    }).catch(() => {});
  };

  switch (node.type) {
    case 'action.send_media': {
      const waType = config.mediaType || 'image';
      await whatsappService.sendMediaByUrl(
        conn, recipient, waType, config.mediaUrl,
        config.caption || '', config.filename || ''
      );
      // Map WhatsApp media type → inbox attachment type so the inbox renders the
      // actual file (image/video/audio/file) instead of an "[image]" placeholder.
      const attachmentType =
        waType === 'document' ? 'file' : waType === 'sticker' ? 'image' : waType;
      // When there's no caption, use a placeholder the inbox hides once it sees
      // the attachment (it suppresses exactly "[image]"/"[video]"/"[audio]"/"[file]").
      const mediaContent = config.caption?.trim() || `[${attachmentType}]`;
      await record(
        mediaContent,
        waType,
        { url: config.mediaUrl, type: attachmentType }
      );
      break;
    }
    case 'action.send_location': {
      await whatsappService.sendLocationMessage(conn, recipient, {
        latitude: config.latitude,
        longitude: config.longitude,
        name: config.name,
        address: config.address
      });
      await record(config.name || config.address || '[location]', 'location');
      break;
    }
    case 'action.send_buttons': {
      await whatsappService.sendReplyButtonsMessage(conn, recipient, {
        bodyText: config.bodyText,
        headerText: config.headerText,
        footerText: config.footerText,
        buttons: Array.isArray(config.buttons) ? config.buttons : []
      });
      await record(config.bodyText || '[buttons]', 'interactive');
      break;
    }
    case 'action.send_list': {
      await whatsappService.sendListMessage(conn, recipient, {
        bodyText: config.bodyText,
        buttonText: config.buttonText,
        headerText: config.headerText,
        footerText: config.footerText,
        sections: Array.isArray(config.sections) ? config.sections : []
      });
      await record(config.bodyText || '[list]', 'interactive');
      break;
    }
    case 'action.send_product': {
      const whatsappCatalogService = require('../../../integrations/whatsapp/whatsappCatalogService');
      const catalogId = await whatsappCatalogService.getLinkedCatalogId(conn);
      const retailerId = await resolveProductRetailerId(organizationId, config.productId);
      if (!catalogId || !retailerId) {
        throw new Error('Send product: catalog or product could not be resolved');
      }
      await whatsappCatalogService.sendProductMessage(
        conn, recipient, catalogId, retailerId, config.bodyText || ''
      );
      await record(config.bodyText || '[product]', 'interactive');
      break;
    }
    case 'action.send_catalog': {
      let thumbnailRetailerId = '';
      if (config.thumbnailProductId) {
        thumbnailRetailerId = await resolveProductRetailerId(organizationId, config.thumbnailProductId) || '';
      }
      await whatsappService.sendCatalogMessage(conn, recipient, {
        bodyText: config.bodyText,
        footerText: config.footerText,
        thumbnailRetailerId
      });
      await record(config.bodyText || '[catalog]', 'interactive');
      break;
    }
    case 'action.send_product_list': {
      const whatsappCatalogService = require('../../../integrations/whatsapp/whatsappCatalogService');
      const catalogId = await whatsappCatalogService.getLinkedCatalogId(conn);
      if (!catalogId) throw new Error('Send multi-product: catalog could not be resolved');

      const sections = [];
      for (const section of (config.productSections || [])) {
        const retailerIds = [];
        for (const pid of (section.productIds || [])) {
          const rid = await resolveProductRetailerId(organizationId, pid);
          if (rid) retailerIds.push(rid);
        }
        if (retailerIds.length) {
          sections.push({ title: section.title || 'Products', productRetailerIds: retailerIds });
        }
      }
      if (!sections.length) throw new Error('Send multi-product: no valid products to send');

      await whatsappCatalogService.sendProductListMessage(
        conn, recipient, catalogId, sections,
        config.headerText || '', config.bodyText || '', config.footerText || ''
      );
      await record(config.bodyText || '[product list]', 'interactive');
      break;
    }
    default:
      break;
  }
}

const WHATSAPP_INTERACTIVE_TYPES = new Set([
  'action.send_media',
  'action.send_location',
  'action.send_buttons',
  'action.send_list',
  'action.send_product',
  'action.send_product_list',
  'action.send_catalog'
]);

async function handleAction(node, ctx) {
  const { config = {} } = node;
  const { dryRun, organizationId, interaction, enrollment } = ctx;

  if (dryRun) {
    return { status: 'continue', nextNodeId: pickEdge(ctx.edges)?.target };
  }

  if (WHATSAPP_INTERACTIVE_TYPES.has(node.type)) {
    await handleWhatsAppInteractive(node, ctx);
    return { status: 'continue', nextNodeId: pickEdge(ctx.edges)?.target };
  }

  switch (node.type) {
    case 'action.send_text': {
      if (!config.text?.trim()) throw new Error('Send text: message is empty');
      const text = flowTemplateService.render(config.text, {
        interaction, variables: enrollment?.variables
      });
      const sendResult = await sendTextForInteraction(ctx.interaction, organizationId, text);
      if (sendResult && !sendResult.sent) {
        if (sendResult.reason === 'no_connection' || sendResult.fatal) {
          const fatalErr = new Error(sendResult.message || `Channel is not connected. Connect it in Settings → Platforms.`);
          fatalErr.fatal = true;
          throw fatalErr;
        }
        // Other non-fatal reasons (e.g. API rate limit) are logged but don't fail the enrollment.
        logger.warn('[FlowHandler] send_text non-fatal send failure', { reason: sendResult.reason });
      }
      break;
    }
    case 'action.offer_services':
    case 'action.offer_slots':
    case 'action.book_appointment':
    case 'action.reschedule_appointment':
    case 'action.cancel_appointment': {
      const apptFlow = require('../appointmentFlowActions');
      const fn = {
        'action.offer_services': apptFlow.offerServices,
        'action.offer_slots': apptFlow.offerSlots,
        'action.book_appointment': apptFlow.bookAppointment,
        'action.reschedule_appointment': apptFlow.rescheduleAppointment,
        'action.cancel_appointment': apptFlow.cancelAppointment
      }[node.type];
      const r = await fn(ctx);
      // `end: true` lets the action terminate the flow (e.g. after too many invalid
      // replies) regardless of edges, so the customer isn't stuck in a re-prompt loop.
      return {
        status: 'continue',
        ...(r.converted ? { converted: true } : {}),
        variables: r.variables || {},
        nextNodeId: r.end ? undefined : pickEdge(ctx.edges, r.branch)?.target
      };
    }
    case 'action.send_template': {
      if (!config.templateId && !config.templateName) throw new Error('Template id required');
      const messageService = require('../flowMessageService');
      const conn = await messageService.getConnection(organizationId, 'whatsapp');
      const recipient = interaction?.author?.platformId || enrollment?.platformUserId;
      if (!conn) {
        const fatalErr = new Error('WhatsApp is not connected. Connect WhatsApp in Settings → Platforms.');
        fatalErr.fatal = true;
        throw fatalErr;
      }
      if (!recipient) {
        const fatalErr = new Error('Cannot send template: contact has no WhatsApp ID.');
        fatalErr.fatal = true;
        throw fatalErr;
      }
      if (!config.templateName) {
        const fatalErr = new Error('No WhatsApp template selected. Choose a template in the node settings.');
        fatalErr.fatal = true;
        throw fatalErr;
      }
      {
        const whatsappService = require('../../../integrations/whatsapp/whatsappService');
        // Interpolate {{tokens}} in each positional variable value before send.
        const tplContext = flowTemplateService.buildContext(interaction, enrollment?.variables);
        const renderedVars = {};
        if (config.variables && typeof config.variables === 'object') {
          for (const [k, v] of Object.entries(config.variables)) {
            renderedVars[k] = typeof v === 'string'
              ? flowTemplateService.render(v, { context: tplContext })
              : v;
          }
        }
        await whatsappService.sendTemplateMessage(
          conn,
          recipient,
          config.templateName,
          config.templateLanguage || 'en',
          buildTemplateComponents(renderedVars)
        );
      }
      break;
    }
    case 'action.send_generic_template': {
      // Instagram/Facebook generic (card) template DM with optional buttons.
      const messageService = require('../flowMessageService');
      const platform = interaction?.platform === 'facebook' ? 'facebook' : 'instagram';
      const conn = await messageService.getConnection(organizationId, platform);
      const recipient = interaction?.author?.platformId || enrollment?.platformUserId;
      if (!conn) {
        const fatalErr = new Error(`${platform} is not connected. Connect it in Settings → Platforms.`);
        fatalErr.fatal = true;
        throw fatalErr;
      }
      if (!recipient) {
        const fatalErr = new Error(`Cannot send template: contact has no ${platform} ID.`);
        fatalErr.fatal = true;
        throw fatalErr;
      }
      const tplContext = flowTemplateService.buildContext(interaction, enrollment?.variables);
      const render = (v) => (typeof v === 'string' ? flowTemplateService.render(v, { context: tplContext }) : '');
      const title = render(config.title).slice(0, 80) || 'Hello';
      const subtitle = render(config.subtitle).slice(0, 80);
      const element = { title };
      if (subtitle) element.subtitle = subtitle;
      const imageUrl = String(config.imageUrl || '').trim();
      if (/^https:\/\//i.test(imageUrl)) element.image_url = imageUrl;
      const rawButtons = Array.isArray(config.buttons) ? config.buttons : [];
      const buttons = rawButtons
        .map((b) => {
          const label = render(b?.label || b?.title).slice(0, 20);
          const url = String(b?.url || '').trim();
          if (!label || !/^https:\/\//i.test(url)) return null;
          return { type: 'web_url', title: label, url };
        })
        .filter(Boolean)
        .slice(0, 3);
      if (buttons.length) element.buttons = buttons;

      const instagramService = require('../../../integrations/meta/instagramService');
      const pageId = conn.platformData?.pageId || conn.platformData?.instagramBusinessAccountId;
      await instagramService.sendGenericTemplateMessage(
        recipient, element, conn.accessToken, pageId, instagramService._connectionType(conn)
      );
      const { recordAutomationReply } = require('../../inbox/inboxAutomationReplyService');
      if (interaction?._id) {
        await recordAutomationReply({
          interactionId: interaction._id,
          organizationId,
          content: subtitle ? `${title} — ${subtitle}` : title,
          messageType: 'instagram_generic_template',
          attachmentUrl: element.image_url || null
        }).catch(() => {});
      }
      break;
    }
    case 'action.send_catalog_product': {
      // Alias of send_product: send a single WhatsApp catalog product card.
      const messageService = require('../flowMessageService');
      const { conn, recipient } = await messageService.resolveWhatsAppTarget(organizationId, interaction, enrollment);
      if (!conn) {
        const fatalErr = new Error('WhatsApp is not connected. Connect WhatsApp in Settings → Platforms.');
        fatalErr.fatal = true;
        throw fatalErr;
      }
      if (!recipient) {
        const fatalErr = new Error('Cannot send catalog product: contact has no WhatsApp ID.');
        fatalErr.fatal = true;
        throw fatalErr;
      }
      if (!config.productId) throw new Error('Send catalog product: productId is required');
      const whatsappCatalogService = require('../../../integrations/whatsapp/whatsappCatalogService');
      const catalogId = await whatsappCatalogService.getLinkedCatalogId(conn);
      const retailerId = await resolveProductRetailerId(organizationId, config.productId);
      if (!catalogId || !retailerId) {
        throw new Error('Send catalog product: catalog or product could not be resolved');
      }
      const bodyText = flowTemplateService.render(config.bodyText || '', {
        interaction, variables: enrollment?.variables
      });
      await whatsappCatalogService.sendProductMessage(conn, recipient, catalogId, retailerId, bodyText);
      if (interaction?._id) {
        const { recordAutomationReply } = require('../../inbox/inboxAutomationReplyService');
        await recordAutomationReply({
          interactionId: interaction._id, organizationId,
          content: bodyText || '[product]', messageType: 'interactive'
        }).catch(() => {});
      }
      break;
    }
    case 'action.create_order': {
      // Create an intent/cart CommerceOrder for the contact from a configured product.
      if (!config.productId) {
        logger.warn('[FlowHandler] create_order skipped: no productId');
        break;
      }
      const Product = require('../../../models/Product');
      const product = await Product.findOne({ _id: config.productId, organization: organizationId })
        .select('name price currency sku')
        .lean();
      if (!product) {
        logger.warn('[FlowHandler] create_order skipped: product not found', { productId: config.productId });
        break;
      }
      const CommerceOrder = require('../../../models/CommerceOrder');
      const { assignOrderDisplayRef } = require('../../../utils/opsRefHelper');
      const platform = interaction?.platform === 'whatsapp' ? 'whatsapp' : 'instagram';
      const buyerId = interaction?.author?.platformId || enrollment?.platformUserId || '';
      const lineItems = [{
        product: product._id,
        retailerId: (product.sku && String(product.sku).trim()) || String(product._id),
        name: product.name,
        qty: 1,
        unitPrice: product.price,
        currency: product.currency || 'AED'
      }];
      const order = await CommerceOrder.create(
        await assignOrderDisplayRef(organizationId, {
          organization: organizationId,
          channel: platform,
          status: 'intent',
          lineItems,
          totalAmount: +Number(product.price || 0).toFixed(2),
          currency: product.currency || 'AED',
          contact: interaction?.contact || enrollment?.contact || undefined,
          sourceInteraction: interaction?._id,
          ...(platform === 'whatsapp' ? { buyerPhone: buyerId } : { instagramUserId: buyerId })
        })
      );
      return {
        status: 'continue',
        converted: true,
        variables: { orderId: String(order._id), orderRef: order.displayRef || '' },
        nextNodeId: pickEdge(ctx.edges)?.target
      };
    }
    case 'action.save_shipping_address': {
      // Persist the address the customer replied with onto the order linked to this
      // conversation, so it shows prefilled in Order Management.
      const CommerceOrder = require('../../../models/CommerceOrder');
      const srcKey = (config.addressVar && String(config.addressVar).trim()) || 'delivery_address';
      let address = String(enrollment?.variables?.[srcKey] || '').trim();
      // Fallback to the latest message ONLY when it is a typed reply — never a
      // quick-reply/button tap (whose content is the button title, not an address).
      if (!address) {
        const isButtonTap = !!(interaction?.metadata?.buttonPayload || interaction?.metadata?.postback);
        if (!isButtonTap) address = String(interaction?.content || '').trim();
      }
      // Reject button titles / non-address replies so we never save e.g. "✅ Yes, ship here".
      if (!isLikelyAddress(address)) {
        logger.info('[FlowHandler] save_shipping_address: ignored non-address reply', { sample: address.slice(0, 40) });
        return { status: 'continue', variables: { address_invalid: true }, nextNodeId: pickEdge(ctx.edges, 'invalid')?.target };
      }

      // Prefer a captured order id; otherwise the active order on this thread.
      const orderId = enrollment?.variables?.orderId;
      const order = await CommerceOrder.findOne(
        orderId
          ? { _id: orderId, organization: organizationId }
          : {
              organization: organizationId,
              sourceInteraction: interaction?._id,
              status: { $nin: ['cancelled', 'refunded', 'returned', 'delivered'] }
            }
      ).sort({ createdAt: -1 });
      if (!order) {
        logger.debug('[FlowHandler] save_shipping_address: no order linked to conversation');
        break;
      }

      // Keep the verbatim text the customer sent, and lift a 6-digit pincode into the
      // structured field so the OMS drawer + edit modal are prefilled.
      const pin = (address.match(/\b(\d{6})\b/) || [])[1] || '';
      const line1 = (pin ? address.replace(pin, '') : address).replace(/^[\s,]+|[\s,]+$/g, '').trim();
      order.shippingAddress = address;
      order.shipping = {
        name: order.shipping?.name || order.buyerName || interaction?.author?.name || '',
        phone: order.shipping?.phone || order.buyerPhone || '',
        line1: line1 || address,
        line2: order.shipping?.line2 || '',
        city: order.shipping?.city || '',
        state: order.shipping?.state || '',
        pincode: pin || order.shipping?.pincode || '',
        country: order.shipping?.country || 'India'
      };
      await order.save();

      // Remember the address on the customer's Contact so repeat orders only need a
      // one-tap confirm (no re-asking). Non-fatal.
      try {
        const Contact = require('../../../models/Contact');
        const contactId = order.contact || interaction?.contact;
        const set = { shippingAddress: address, shipping: order.shipping, shippingUpdatedAt: new Date() };
        if (contactId) {
          await Contact.updateOne({ _id: contactId, organization: organizationId }, { $set: set });
        } else {
          const phone = order.buyerPhone || interaction?.author?.platformId;
          if (phone) {
            await Contact.updateOne(
              { organization: organizationId, $or: [{ primaryPhone: phone }, { 'channels.platformUserId': phone }] },
              { $set: set }
            );
          }
        }
      } catch (e) {
        logger.debug('[FlowHandler] save_shipping_address: contact update skipped', { error: e.message });
      }

      logger.info('[FlowHandler] save_shipping_address: saved to order', {
        orderId: String(order._id), pincode: pin || undefined
      });
      return {
        status: 'continue',
        variables: { orderId: String(order._id), delivery_address: address, address_invalid: false },
        nextNodeId: pickEdge(ctx.edges, 'saved')?.target
      };
    }
    case 'action.save_payment_method': {
      const CommerceOrder = require('../../../models/CommerceOrder');
      const {
        resolvePaymentMethod,
        paymentLabel
      } = require('../../../integrations/whatsapp/whatsappOrderDetailsHelper');

      const varKey = (config.methodVar && String(config.methodVar).trim()) || 'payment_method';
      let method = String(enrollment?.variables?.[varKey] || '').trim().toLowerCase();
      if (!method) {
        method = resolvePaymentMethod({
          buttonPayload: interaction?.metadata?.buttonPayload || interaction?.metadata?.postback,
          text: interaction?.content
        });
      }
      if (!method) {
        logger.info('[FlowHandler] save_payment_method: could not resolve method from reply');
        return {
          status: 'continue',
          variables: { payment_invalid: true },
          nextNodeId: pickEdge(ctx.edges, 'invalid')?.target
        };
      }

      const orderId = enrollment?.variables?.orderId;
      const order = await CommerceOrder.findOne(
        orderId
          ? { _id: orderId, organization: organizationId }
          : {
              organization: organizationId,
              sourceInteraction: interaction?._id,
              status: { $nin: ['cancelled', 'refunded', 'returned', 'delivered'] }
            }
      ).sort({ createdAt: -1 });

      if (!order) {
        logger.debug('[FlowHandler] save_payment_method: no order linked');
        break;
      }

      order.paymentMethod = method;
      await order.save();

      const label = paymentLabel(method);
      logger.info('[FlowHandler] save_payment_method: saved', { orderId: String(order._id), method });
      return {
        status: 'continue',
        variables: {
          orderId: String(order._id),
          payment_method: method,
          payment_method_label: label,
          payment_invalid: false
        },
        nextNodeId: pickEdge(ctx.edges, 'saved')?.target || pickEdge(ctx.edges)?.target
      };
    }
    case 'action.send_order_details': {
      const CommerceOrder = require('../../../models/CommerceOrder');
      const messageService = require('../flowMessageService');
      const whatsappService = require('../../../integrations/whatsapp/whatsappService');
      const {
        buildOrderDetailsInteractive,
        buildOrderSummaryText,
        buildPaymentSettings
      } = require('../../../integrations/whatsapp/whatsappOrderDetailsHelper');
      const { recordAutomationReply } = require('../../inbox/inboxAutomationReplyService');

      const orderId = enrollment?.variables?.orderId;
      const order = await CommerceOrder.findOne(
        orderId
          ? { _id: orderId, organization: organizationId }
          : {
              organization: organizationId,
              sourceInteraction: interaction?._id,
              status: { $nin: ['cancelled', 'refunded', 'returned', 'delivered'] }
            }
      ).sort({ createdAt: -1 }).lean();

      if (!order) {
        // Not a fatal error — the order hasn't been created yet at this point in the flow.
        logger.warn('[FlowHandler] send_order_details: no order found — skipping (non-fatal)');
        break;
      }

      const { conn, recipient } = await messageService.resolveWhatsAppTarget(organizationId, interaction, enrollment);
      if (!conn) {
        const fatalErr = new Error('WhatsApp is not connected. Connect WhatsApp in Settings → Platforms.');
        fatalErr.fatal = true;
        throw fatalErr;
      }
      if (!recipient) {
        const fatalErr = new Error('Cannot send order details: contact has no WhatsApp ID.');
        fatalErr.fatal = true;
        throw fatalErr;
      }

      const tplContext = flowTemplateService.buildContext(interaction, enrollment?.variables);
      const render = (v) => (typeof v === 'string' ? flowTemplateService.render(v, { context: tplContext }) : v);
      const paymentMethod = String(
        enrollment?.variables?.payment_method || order.paymentMethod || ''
      ).toLowerCase();
      const deliveryAddress = enrollment?.variables?.delivery_address || order.shippingAddress || '';
      const catalogId = conn.platformData?.catalogId || '';

      const payOpts = {
        gatewayType: config.gatewayType || 'razorpay',
        configurationName: render(config.configurationName || 'default')
      };

      const useMetaOrderDetails = paymentMethod !== 'cod'
        && buildPaymentSettings(paymentMethod, payOpts)?.length;

      const Organization = require('../../../models/Organization');
      const org = await Organization.findById(organizationId).select('name profile.company').lean();
      const importerName = org?.profile?.company || org?.name || 'Seller';

      try {
        if (useMetaOrderDetails) {
          const interactive = buildOrderDetailsInteractive(order, {
            bodyText: render(config.bodyText || 'Review your order and complete payment.'),
            headerText: render(config.headerText || ''),
            footerText: render(config.footerText || ''),
            catalogId,
            goodsType: config.goodsType || 'physical-goods',
            paymentMethod,
            importerName,
            importerAddress: 'India',
            ...payOpts,
            referenceId: order.displayRef || String(order._id)
          });
          await whatsappService.sendOrderDetailsMessage(conn, recipient, interactive);
          logger.info('[FlowHandler] send_order_details: Meta order_details sent', {
            orderId: String(order._id),
            referenceId: order.displayRef,
            paymentMethod,
            configurationName: payOpts.configurationName
          });
          if (interaction?._id) {
            await recordAutomationReply({
              interactionId: interaction._id,
              organizationId,
              content: render(config.bodyText || '[Order details]'),
              messageType: 'interactive'
            }).catch(() => {});
          }
        } else {
          logger.warn('[FlowHandler] send_order_details: using text fallback (payments not configured or COD)', {
            orderId: String(order._id),
            paymentMethod,
            configurationName: payOpts.configurationName
          });
          const summary = buildOrderSummaryText(order, {
            paymentMethodLabel: enrollment?.variables?.payment_method_label || paymentMethod,
            deliveryAddress
          });
          await whatsappService.sendTextMessage(conn, recipient, summary);
          if (interaction?._id) {
            await recordAutomationReply({
              interactionId: interaction._id,
              organizationId,
              content: summary,
              messageType: 'text'
            }).catch(() => {});
          }
        }
      } catch (err) {
        logger.warn('[FlowHandler] send_order_details failed, sending text fallback', {
          error: err.message,
          orderId: String(order._id),
          paymentMethod,
          configurationName: payOpts.configurationName
        });
        const fallback = buildOrderSummaryText(order, {
          paymentMethodLabel: enrollment?.variables?.payment_method_label || paymentMethod,
          deliveryAddress
        });
        await whatsappService.sendTextMessage(conn, recipient, fallback).catch(() => {});
      }
      break;
    }
    case 'action.load_saved_address': {
      // Load the customer's remembered address into {{saved_address}} so the flow can
      // offer a one-tap confirm instead of re-asking. Empty when none on file — or when
      // the stored value isn't a real address (defensively ignore corrupted data).
      const Contact = require('../../../models/Contact');
      let contact = null;
      if (interaction?.contact) {
        contact = await Contact.findById(interaction.contact).select('shippingAddress').lean();
      }
      if (!contact) {
        const phone = interaction?.author?.platformId || enrollment?.platformUserId;
        if (phone) {
          contact = await Contact.findOne({
            organization: organizationId,
            $or: [{ primaryPhone: phone }, { 'channels.platformUserId': phone }]
          }).select('shippingAddress').lean();
        }
      }
      const stored = (contact?.shippingAddress && String(contact.shippingAddress).trim()) || '';
      const saved = isLikelyAddress(stored) ? stored : '';
      return {
        status: 'continue',
        variables: { saved_address: saved },
        nextNodeId: pickEdge(ctx.edges)?.target
      };
    }
    case 'action.link_comment_thread': {
      // Persist the link between a public comment and the resulting DM thread so
      // analytics/inbox can correlate them. Stored on the interaction metadata.
      if (interaction?._id) {
        const Interaction = require('../../../models/Interaction');
        await Interaction.updateOne(
          { _id: interaction._id },
          { $set: {
            'metadata.linkedCommentId': interaction.metadata?.commentId || interaction.parentId || interaction.platformId,
            'metadata.flowLinkedThread': true
          } }
        ).catch((err) => logger.warn('[FlowHandler] link_comment_thread failed', { error: err.message }));
      }
      break;
    }
    case 'action.tag_contact': {
      if (config.tag) {
        const Contact = require('../../../models/Contact');
        const platformUserId = interaction?.author?.platformId || enrollment?.platformUserId;
        if (platformUserId) {
          await Contact.updateOne(
            { organization: organizationId, 'channels.platformUserId': platformUserId },
            { $addToSet: { tags: String(config.tag).trim() } }
          );
        }
      }
      break;
    }
    case 'action.reply_public_comment': {
      if (interaction?.type === 'comment' && config.text) {
        const conn = await require('../flowMessageService').getConnection(organizationId, 'instagram');
        if (conn) {
          const instagramService = require('../../../integrations/meta/instagramService');
          const text = flowTemplateService.render(config.text, {
            interaction, variables: enrollment?.variables
          });
          await instagramService.replyToComment(
            interaction.platformId,
            text,
            conn.accessToken,
            instagramService._connectionType(conn)
          );
        }
      }
      break;
    }
    case 'action.send_post_products': {
      // Workflow-native equivalent of the AI comment-to-DM seller: resolve the
      // product(s) linked to the commented post and DM the commenter — single
      // product → CTA, multiple → carousel picker (private reply). Reuses the
      // shared core in commentToDmService (dedup, daily caps, order records).
      if (interaction?.platform === 'instagram' && interaction?.type === 'comment') {
        const commentToDmService = require('../../commentToDmService');
        await commentToDmService.sendPostLinkedProductsDM(interaction, organizationId, {
          // The flow owns any public comment reply via its own reply_public_comment
          // node, so don't post a second public stub here unless explicitly enabled.
          publicStub: config.postPublicReply === true
        });
      }
      break;
    }
    case 'action.ai_reply': {
      const aiReplyGate = await aiNodeEntitlement(organizationId);
      if (!aiReplyGate.allowed) {
        return {
          status: 'continue',
          warning: `AI reply skipped — ${aiReplyGate.reason}`,
          nextNodeId: pickEdge(ctx.edges)?.target
        };
      }
      const replyGenerationService = require('../../ai/replyGenerationService');
      const Interaction = require('../../../models/Interaction');
      const fullInteraction = interaction?._id
        ? await Interaction.findById(interaction._id)
        : null;
      if (!fullInteraction) {
        return {
          status: 'continue',
          warning: 'AI reply skipped — no interaction context available.',
          nextNodeId: pickEdge(ctx.edges)?.target
        };
      }
      try {
        const reply = await replyGenerationService.generateResponseOpenAI(
          fullInteraction,
          organizationId,
          null,
          { autoReplyTone: config.tone }
        );
        if (reply?.content) {
          await sendTextForInteraction(fullInteraction, organizationId, reply.content);
        } else {
          return {
            status: 'continue',
            warning: 'AI reply generated no content — skipped.',
            nextNodeId: pickEdge(ctx.edges)?.target
          };
        }
      } catch (aiErr) {
        logger.warn('[FlowHandler] ai_reply failed', { error: aiErr.message });
        return {
          status: 'continue',
          warning: `AI reply failed: ${aiErr.message}`,
          nextNodeId: pickEdge(ctx.edges)?.target
        };
      }
      break;
    }
    case 'action.ai_detect_intent': {
      const intentGate = await aiNodeEntitlement(organizationId, { decisioning: true });
      if (!intentGate.allowed) {
        return {
          status: 'continue',
          warning: `Intent detection skipped — ${intentGate.reason}`,
          nextNodeId: pickEdge(ctx.edges)?.target
        };
      }
      const saveAs = (config.saveAs && String(config.saveAs).trim()) || 'intent';
      const text = String(interaction?.content || '').trim();
      let intent = 'other';
      if (text) {
        const candidates = Array.isArray(config.intents)
          ? config.intents.map((s) => String(s).trim()).filter(Boolean)
          : [];
        if (candidates.length) {
          // Custom label set — classify into one of the author's intents.
          const replyGenerationService = require('../../ai/replyGenerationService');
          const system = `You are an intent classifier. Read the customer message and respond with ONLY one label from this list (lowercase, no punctuation): ${candidates.join(', ')}. If none clearly fit, respond with "other".`;
          try {
            const raw = await replyGenerationService.generateText(system, `Message: "${text}"`, {
              temperature: 0, maxTokens: 12, feature: 'flow_ai_node'
            });
            const got = String(raw || '').toLowerCase().replace(/[^a-z0-9_ ]/g, '').trim();
            intent = candidates.find((c) => c.toLowerCase() === got) || (got === 'other' ? 'other' : (candidates.find((c) => got.includes(c.toLowerCase())) || 'other'));
          } catch (err) {
            logger.warn('[FlowHandler] ai_detect_intent failed (fallback "other")', { error: err.message });
          }
        } else {
          // Open-ended — reuse the coarse classifier.
          const intentClassificationService = require('../../ai/intentClassificationService');
          intent = await intentClassificationService.detectIntent(text);
        }
      }
      return {
        status: 'continue',
        variables: { [saveAs]: intent },
        nextNodeId: pickEdge(ctx.edges)?.target
      };
    }
    case 'action.ai_extract': {
      const extractGate = await aiNodeEntitlement(organizationId, { decisioning: true });
      if (!extractGate.allowed) {
        return {
          status: 'continue',
          warning: `Field extraction skipped — ${extractGate.reason}`,
          nextNodeId: pickEdge(ctx.edges)?.target
        };
      }
      const saveAs = (config.saveAs && String(config.saveAs).trim()) || 'extracted';
      const fields = Array.isArray(config.fields)
        ? config.fields.map((f) => String(f).trim()).filter(Boolean)
        : [];
      const text = String(interaction?.content || '').trim();
      let extracted = {};
      if (text && fields.length) {
        const replyGenerationService = require('../../ai/replyGenerationService');
        const system = `You extract structured data from a customer message. Return ONLY a JSON object (no markdown, no commentary) with exactly these keys: ${fields.join(', ')}. Use a concise string value for each key. If a value is not present in the message, use an empty string "".`;
        try {
          const raw = await replyGenerationService.generateText(system, `Message: "${text}"`, {
            temperature: 0, maxTokens: 300, feature: 'flow_ai_node'
          });
          const match = String(raw || '').match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            // Keep only the requested fields, coerced to strings.
            for (const f of fields) {
              extracted[f] = parsed[f] == null ? '' : String(parsed[f]);
            }
          }
        } catch (err) {
          logger.warn('[FlowHandler] ai_extract failed (empty result)', { error: err.message });
        }
      }
      // Save the whole object, plus each field individually for easy condition checks.
      const variables = { [saveAs]: extracted };
      for (const f of fields) variables[f] = extracted[f] ?? '';
      return {
        status: 'continue',
        variables,
        nextNodeId: pickEdge(ctx.edges)?.target
      };
    }
    case 'action.payment.request': {
      // Create or reuse a payment link for the open order in this conversation.
      // Amount is resolved from the CommerceOrder — never from flow config.
      const conversationalPayments = require('../../payments/conversationalPaymentOrchestrator');
      const result = await conversationalPayments.handlePaymentIntent({
        intentType: 'payment_request',
        organizationId,
        contactId: interaction?.contact ? String(interaction.contact) : null,
        interactionId: interaction?._id ? String(interaction._id) : null,
        channel: interaction?.platform || config.channel || 'manual',
        orderId: enrollment?.variables?.orderId || null,
        createdBy: 'system'
      });

      if (result.action === 'payment_link_ready') {
        const msg = conversationalPayments.buildPayNowMessage({
          paymentUrl: result.payment.shortUrl || result.payment.paymentUrl,
          orderRef: result.order?.ref || '—',
          amount: result.payment.amount,
          currency: result.payment.currency
        });
        await sendTextForInteraction(interaction, organizationId, msg).catch((err) =>
          logger.warn('[FlowHandler] payment.request send failed', { error: err.message })
        );
        return {
          status: 'continue',
          variables: {
            paymentId: String(result.payment._id),
            paymentUrl: result.payment.shortUrl || result.payment.paymentUrl,
            paymentStatus: result.payment.status
          },
          nextNodeId: pickEdge(ctx.edges, 'sent')?.target || pickEdge(ctx.edges)?.target
        };
      }
      logger.info('[FlowHandler] payment.request: no link created', { action: result.action, reason: result.reason });
      return {
        status: 'continue',
        variables: { paymentId: null, paymentUrl: null, paymentStatus: result.action },
        nextNodeId: pickEdge(ctx.edges, result.action)?.target || pickEdge(ctx.edges)?.target
      };
    }
    case 'action.payment.send_reminder': {
      // Send reminder only if active payment exists and is still unpaid.
      const paymentId = enrollment?.variables?.paymentId;
      if (!paymentId) {
        logger.info('[FlowHandler] payment.send_reminder: no paymentId in variables — skipping');
        return { status: 'continue', nextNodeId: pickEdge(ctx.edges)?.target };
      }
      const Payment = require('../../../models/Payment');
      const payment = await Payment.findOne({ _id: paymentId, organization: organizationId })
        .select('status shortUrl paymentUrl amount currency').lean();
      if (!payment || !['created', 'pending'].includes(payment.status)) {
        logger.info('[FlowHandler] payment.send_reminder: payment not active — skipping', {
          paymentId,
          status: payment?.status
        });
        return { status: 'continue', nextNodeId: pickEdge(ctx.edges, 'already_paid')?.target || pickEdge(ctx.edges)?.target };
      }
      const reminderText = config.message || `Hi! Just a reminder — your payment link is still active: ${payment.shortUrl || payment.paymentUrl}`;
      await sendTextForInteraction(interaction, organizationId, reminderText).catch((err) =>
        logger.warn('[FlowHandler] payment.send_reminder send failed', { error: err.message })
      );
      return { status: 'continue', nextNodeId: pickEdge(ctx.edges, 'sent')?.target || pickEdge(ctx.edges)?.target };
    }
      if (config.bucketId && interaction?._id) {
        const Interaction = require('../../../models/Interaction');
        await Interaction.findByIdAndUpdate(interaction._id, { intentBucket: config.bucketId });
      }
      break;
    }
    case 'action.escalate_human': {
      const org = await Organization.findById(organizationId);
      const Interaction = require('../../../models/Interaction');
      const fullInteraction = interaction?._id ? await Interaction.findById(interaction._id) : null;
      if (fullInteraction && org) {
        const reason = config.reason && String(config.reason).trim();
        // Tell the customer a human is taking over. Prefer an explicit handoff message;
        // fall back to a non-placeholder reason, then the org's handoff template.
        const handoffRaw = (config.message && String(config.message).trim())
          || (reason && reason !== 'Needs human review' ? reason : '')
          || (org.escalationSettings?.handoffMessageTemplate && String(org.escalationSettings.handoffMessageTemplate).trim())
          || '';
        if (handoffRaw) {
          const text = flowTemplateService.render(handoffRaw, { interaction, variables: enrollment?.variables });
          await sendTextForInteraction(interaction, organizationId, text)
            .catch((err) => logger.warn('[FlowHandler] escalate handoff message failed', { error: err.message }));
        }
        const escalationService = require('../../escalationService');
        await escalationService.escalateInteraction(
          fullInteraction,
          org,
          [reason || 'flow_escalation'],
          'automation'
        ).catch((err) => logger.warn('[FlowHandler] escalate_human failed', { error: err.message, interactionId: fullInteraction._id }));
      }
      break;
    }
    case 'action.set_variable': {
      const varKey = String(config.key || '').trim();
      if (!varKey) {
        logger.warn('[FlowHandler] set_variable skipped: empty key');
        return { status: 'continue', nextNodeId: pickEdge(ctx.edges)?.target };
      }
      // Interpolate the value so you can compose variables (e.g. "{{name}} (VIP)").
      const value = typeof config.value === 'string'
        ? flowTemplateService.render(config.value, { interaction, variables: enrollment?.variables })
        : config.value;
      return {
        status: 'continue',
        variables: { [varKey]: value },
        nextNodeId: pickEdge(ctx.edges)?.target
      };
    }
    case 'action.set_stage': {
      const SalesConversationState = require('../../../models/SalesConversationState');
      if (interaction?.author?.platformId) {
        await SalesConversationState.findOneAndUpdate(
          { organization: organizationId, platformUserId: interaction.author.platformId },
          { stage: config.stage },
          { upsert: true }
        );
      }
      break;
    }
    case 'action.webhook_out': {
      if (config.url) {
        const axios = require('axios');
        await axios({
          method: config.method || 'POST',
          url: config.url,
          data: { variables: enrollment.variables, interactionId: interaction?._id },
          timeout: 10000
        }).catch((err) => logger.warn('[FlowHandler] webhook_out failed', { error: err.message }));
      }
      break;
    }
    case 'action.http_request': {
      if (config.url) {
        const axios = require('axios');
        const method = String(config.method || 'GET').toUpperCase();
        let httpErr = null;
        const resp = await axios({
          method,
          url: config.url,
          headers: (config.headers && typeof config.headers === 'object') ? config.headers : undefined,
          data: (method !== 'GET' && config.body && typeof config.body === 'object') ? config.body : undefined,
          timeout: 10000
        }).catch((err) => {
          httpErr = err.message;
          logger.warn('[FlowHandler] http_request failed', { error: err.message, url: config.url });
          return null;
        });
        if (httpErr) {
          return {
            status: 'continue',
            warning: `HTTP request failed: ${httpErr}`,
            nextNodeId: pickEdge(ctx.edges)?.target
          };
        }
        if (resp && config.saveAs) {
          return {
            status: 'continue',
            variables: { [config.saveAs]: resp.data, [`${config.saveAs}_status`]: resp.status },
            nextNodeId: pickEdge(ctx.edges)?.target
          };
        }
      }
      break;
    }
    default:
      logger.debug('[FlowHandler] unhandled action', { type: node.type });
  }

  return { status: 'continue', nextNodeId: pickEdge(ctx.edges)?.target };
}

async function handleCondition(node, ctx) {
  const { config = {} } = node;
  const text = (ctx.interaction?.content || '').toLowerCase();
  let match = false;

  switch (node.type) {
    case 'condition.keyword_match':
    case 'condition.reply_contains': {
      const keys = config.keywords || (config.text ? [config.text] : []);
      match = keys.some((k) => text.includes(String(k).toLowerCase()));
      break;
    }
    case 'condition.button_clicked':
      match = ctx.interaction?.metadata?.postback === config.payload
        || ctx.interaction?.metadata?.buttonPayload === config.payload;
      break;
    case 'condition.sentiment':
      match = ctx.interaction?.sentiment === config.sentiment;
      break;
    case 'condition.variable': {
      const val = String(ctx.enrollment?.variables?.[config.key] ?? '');
      const target = String(config.value ?? '');
      if (config.operator === 'neq') match = val !== target;
      else if (config.operator === 'contains') match = val.includes(target);
      else match = val === target;
      break;
    }
    case 'condition.intent_bucket':
      match = String(ctx.interaction?.intentBucket) === String(config.bucketId);
      break;
    case 'condition.product_count': {
      const count = Number(
        ctx.enrollment?.variables?.productCount
        ?? (Array.isArray(ctx.interaction?.metadata?.products) ? ctx.interaction.metadata.products.length : 0)
      );
      const target = Number(config.count) || 0;
      if (config.operator === 'gt') match = count > target;
      else if (config.operator === 'lt') match = count < target;
      else match = count === target;
      break;
    }
    case 'condition.feature_enabled': {
      try {
        const entitlementsService = require('../../entitlementsService');
        match = await entitlementsService.can(ctx.organizationId, config.feature);
      } catch (err) {
        logger.warn('[FlowHandler] feature_enabled check failed (fail-open)', { error: err.message });
        match = true;
      }
      break;
    }
    case 'condition.business_hours': {
      match = isWithinBusinessHours(config);
      break;
    }
    case 'condition.dedup_rate_limit': {
      // True (yes branch) while under the per-contact daily cap; increments the
      // counter only when allowed so the gate is idempotent per pass.
      match = await checkRateLimit(ctx, config);
      break;
    }
    case 'condition.payment.status': {
      // Check the payment status stored in flow variables against a configured status.
      const paymentId = ctx.enrollment?.variables?.paymentId;
      const targetStatus = config.status || 'paid';
      if (!paymentId) {
        match = false;
      } else {
        try {
          const Payment = require('../../../models/Payment');
          const p = await Payment.findOne({ _id: paymentId, organization: ctx.organizationId })
            .select('status').lean();
          match = p ? p.status === targetStatus : false;
        } catch {
          match = false;
        }
      }
      break;
    }
    default:
      match = true;
  }

  const edge = pickBranchEdge(ctx.edges, match);
  return { status: 'continue', nextNodeId: edge?.target, branchTaken: match ? 'yes' : 'no' };
}

async function handleWait(node, ctx) {
  const { config = {} } = node;
  if (ctx.dryRun) {
    return { status: 'continue', nextNodeId: pickEdge(ctx.edges)?.target };
  }

  switch (node.type) {
    case 'wait.delay': {
      const sec = Number(config.delaySec) || 60;
      return {
        status: 'waiting',
        delaySec: sec,
        nextRunAt: new Date(Date.now() + sec * 1000)
      };
    }
    case 'wait.human_delay': {
      const min = Number(config.minSec) || 30;
      const max = Number(config.maxSec) || 120;
      const sec = min + Math.floor(Math.random() * Math.max(1, max - min + 1));
      return { status: 'waiting', delaySec: sec, nextRunAt: new Date(Date.now() + sec * 1000) };
    }
    case 'wait.user_reply': {
      const sec = Number(config.timeoutSec) || 86400;
      return { status: 'waiting', delaySec: sec, nextRunAt: new Date(Date.now() + sec * 1000) };
    }
    case 'wait.quiet_hours': {
      // If we're currently inside the flow's quiet-hours window, park until it
      // ends; otherwise continue immediately.
      const settings = ctx.flow?.settings || {};
      const sec = secondsUntilQuietHoursEnd(settings);
      if (sec <= 0) {
        return { status: 'continue', nextNodeId: pickEdge(ctx.edges)?.target };
      }
      return { status: 'waiting', delaySec: sec, nextRunAt: new Date(Date.now() + sec * 1000) };
    }
    default:
      return { status: 'continue', nextNodeId: pickEdge(ctx.edges)?.target };
  }
}

async function handleControl(node, ctx) {
  if (node.type === 'control.end') {
    return { status: 'completed' };
  }
  if (node.type === 'control.jump') {
    return { status: 'continue', nextNodeId: node.config?.targetNodeId || pickEdge(ctx.edges)?.target };
  }
  if (node.type === 'control.ab_split') {
    const pct = Math.min(100, Math.max(0, Number(node.config?.splitPercent ?? 50)));
    const goA = Math.random() * 100 < pct;
    const edges = ctx.edges || [];
    const labeled = edges.find((e) => edgeBranch(e) === (goA ? 'a' : 'b'));
    const edge = labeled || (goA ? edges[0] : edges[1]) || edges[0];
    return { status: 'continue', nextNodeId: edge?.target, branchTaken: goA ? 'A' : 'B' };
  }
  if (node.type === 'control.random_branch') {
    const edges = ctx.edges || [];
    const edge = edges.length ? edges[Math.floor(Math.random() * edges.length)] : null;
    return { status: 'continue', nextNodeId: edge?.target };
  }
  return { status: 'continue', nextNodeId: pickEdge(ctx.edges)?.target };
}

async function executeNodeHandler(ctx) {
  const { node } = ctx;
  const category = node.type.split('.')[0];

  switch (category) {
    case 'action':
      return handleAction(node, ctx);
    case 'condition':
      return handleCondition(node, ctx);
    case 'wait':
      return handleWait(node, ctx);
    case 'control':
      return handleControl(node, ctx);
    default:
      return { status: 'continue', nextNodeId: pickEdge(ctx.edges)?.target };
  }
}

module.exports = { executeNodeHandler, pickEdge, isLikelyAddress };
