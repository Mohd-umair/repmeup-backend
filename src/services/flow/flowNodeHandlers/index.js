const { sendTextForInteraction } = require('../flowMessageService');
const Organization = require('../../../models/Organization');
const logger = require('../../../config/logger');

const TRUE_BRANCHES = ['yes', 'true', 'match', 'matched'];
const FALSE_BRANCHES = ['no', 'false', 'nomatch', 'unmatched', 'else', 'default'];

/** Normalize an edge's branch label for comparison. */
function edgeBranch(edge) {
  return String(edge?.label || edge?.condition?.branch || '').trim().toLowerCase();
}

/**
 * Pick the outgoing edge. When `preferLabel` is given, prefer an edge whose
 * branch matches; otherwise fall back to the first unlabeled/default edge.
 */
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
  const { config = {} } = node;
  const { organizationId, interaction, enrollment } = ctx;
  const messageService = require('../flowMessageService');
  const whatsappService = require('../../../integrations/whatsapp/whatsappService');
  const { recordAutomationReply } = require('../../inbox/inboxAutomationReplyService');

  const { conn, recipient } = await messageService.resolveWhatsAppTarget(organizationId, interaction, enrollment);
  if (!conn || !recipient) {
    logger.warn('[FlowHandler] whatsapp interactive skipped', {
      type: node.type, hasConn: !!conn, hasRecipient: !!recipient
    });
    return;
  }

  const record = (content, messageType) => {
    if (!interaction?._id) return Promise.resolve();
    return recordAutomationReply({
      interactionId: interaction._id,
      organizationId,
      content,
      messageType
    }).catch(() => {});
  };

  switch (node.type) {
    case 'action.send_media': {
      await whatsappService.sendMediaByUrl(
        conn, recipient, config.mediaType || 'image', config.mediaUrl,
        config.caption || '', config.filename || ''
      );
      await record(config.caption || `[${config.mediaType || 'media'}]`, config.mediaType || 'media');
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
      await sendTextForInteraction(ctx.interaction, organizationId, config.text);
      break;
    }
    case 'action.send_template': {
      if (!config.templateId && !config.templateName) throw new Error('Template id required');
      const messageService = require('../flowMessageService');
      const conn = await messageService.getConnection(organizationId, 'whatsapp');
      const recipient = interaction?.author?.platformId || enrollment?.platformUserId;
      if (conn && recipient && config.templateName) {
        const whatsappService = require('../../../integrations/whatsapp/whatsappService');
        await whatsappService.sendTemplateMessage(
          conn,
          recipient,
          config.templateName,
          config.templateLanguage || 'en',
          buildTemplateComponents(config.variables)
        );
      } else {
        logger.warn('[FlowHandler] send_template skipped', {
          hasConn: !!conn, hasRecipient: !!recipient, templateName: config.templateName
        });
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
          await instagramService.replyToComment(
            interaction.platformId,
            config.text,
            conn.accessToken,
            conn.platformData?.connectionType
          );
        }
      }
      break;
    }
    case 'action.ai_reply': {
      const replyGenerationService = require('../../ai/replyGenerationService');
      const Interaction = require('../../../models/Interaction');
      const fullInteraction = interaction?._id
        ? await Interaction.findById(interaction._id)
        : null;
      if (fullInteraction) {
        const reply = await replyGenerationService.generateResponseOpenAI(
          fullInteraction,
          organizationId,
          null,
          { autoReplyTone: config.tone }
        );
        if (reply?.content) {
          await sendTextForInteraction(fullInteraction, organizationId, reply.content);
        }
      }
      break;
    }
    case 'action.ai_detect_intent': {
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
    case 'action.assign_bucket': {
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
        const escalationService = require('../../escalationService');
        await escalationService.escalateInteraction(
          fullInteraction,
          org,
          [config.reason || 'flow_escalation'],
          'automation'
        ).catch(() => {});
      }
      break;
    }
    case 'action.set_variable':
      return {
        status: 'continue',
        variables: { [config.key]: config.value },
        nextNodeId: pickEdge(ctx.edges)?.target
      };
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
        const resp = await axios({
          method,
          url: config.url,
          headers: (config.headers && typeof config.headers === 'object') ? config.headers : undefined,
          data: (method !== 'GET' && config.body && typeof config.body === 'object') ? config.body : undefined,
          timeout: 10000
        }).catch((err) => {
          logger.warn('[FlowHandler] http_request failed', { error: err.message, url: config.url });
          return null;
        });
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
    case 'wait.quiet_hours':
      return { status: 'waiting', delaySec: 3600, nextRunAt: new Date(Date.now() + 3600 * 1000) };
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

module.exports = { executeNodeHandler, pickEdge };
