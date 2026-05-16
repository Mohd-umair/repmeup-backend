/**
 * WhatsApp Template Service
 *
 * Business logic for managing WhatsApp message templates via the
 * Meta Business Management API (Graph v23.0).
 *
 * API reference:
 *   https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
 *
 * All methods accept `organizationId` (for DB scoping) and a resolved
 * `PlatformConnection` document whose `accessToken` and
 * `platformData.wabaId` or `platformData.businessAccountId` (WhatsApp Business
 * Account ID — not the phone number ID) are used for Graph calls.
 */

const path = require('path');
const axios = require('axios');
const WhatsAppTemplate = require('../models/WhatsAppTemplate');
const PlatformConnection = require('../models/PlatformConnection');
const logger = require('../config/logger');
const whatsappLoginAuth = require('../integrations/whatsapp/whatsappLoginAuth');

const GRAPH_BASE = 'https://graph.facebook.com/v23.0';

// ── Helpers ──────────────────────────────────────────────────────────────────

function _token(connection) {
  return connection?.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
}

function _wabaId(connection) {
  const pd = connection?.platformData || {};
  // Embedded Signup stores WABA on wabaId; env/direct flow often uses businessAccountId.
  // Never use phoneNumberId here — message_templates is only on the WABA object.
  return (
    pd.wabaId ||
    pd.businessAccountId ||
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID
  );
}

function _authHeaders(connection) {
  return {
    Authorization: `Bearer ${_token(connection)}`,
    'Content-Type': 'application/json'
  };
}

/** Resolve the active WhatsApp PlatformConnection for an organisation. */
async function _resolveConnection(organizationId, connectionId = null) {
  const query = { organization: organizationId, platform: 'whatsapp', isActive: true };
  if (connectionId) query._id = connectionId;
  const conn = await PlatformConnection.findOne(query).lean();
  if (!conn) {
    const err = new Error('No active WhatsApp connection found for this organisation.');
    err.statusCode = 400;
    err.code = 'NO_WHATSAPP_CONNECTION';
    throw err;
  }
  return conn;
}

/** Parse Meta API errors into clean objects. */
function _parseMetaError(error) {
  const d = error.response?.data?.error;
  return {
    statusCode: error.response?.status || 500,
    metaCode: d?.code,
    metaSubcode: d?.error_subcode,
    message: d?.message || error.message || 'Meta API error'
  };
}

/** Meta error 100 / subcode 33: wrong object id for this token (often WABA vs phone id). */
function _isWabaObjectNotAccessible(parsed) {
  return parsed.metaCode === 100 && parsed.metaSubcode === 33;
}

async function _persistWabaCanonical(connectionLean, wabaId) {
  if (!connectionLean?._id || !wabaId) return;
  await PlatformConnection.updateOne(
    { _id: connectionLean._id },
    {
      $set: {
        'platformData.wabaId': String(wabaId),
        'platformData.businessAccountId': String(wabaId)
      }
    }
  );
}

/**
 * Discover canonical WABA id from token (debug_token) + phone_numbers match.
 */
async function _discoverWabaFromPhone(connection) {
  const token = _token(connection);
  const phoneNumberId =
    connection?.platformData?.phoneNumberId || connection?.platformUserId;
  if (!token || !phoneNumberId) return null;
  return whatsappLoginAuth.resolveWabaIdForPhoneNumber(token, phoneNumberId);
}

/**
 * If Graph says the WABA id is invalid, try token+phone discovery, persist, return new id.
 * @returns {Promise<string|null>} updated WABA id or null
 */
async function _recoverWabaIdIfNeeded(connection, wabaId, parsedError) {
  if (!_isWabaObjectNotAccessible(parsedError)) return null;
  const phoneNumberId =
    connection?.platformData?.phoneNumberId || connection?.platformUserId;
  if (!phoneNumberId || !_token(connection)) return null;

  const discovered = await _discoverWabaFromPhone(connection);
  if (!discovered || String(discovered) === String(wabaId)) return null;

  logger.warn('[TemplateService] Correcting WABA id via Meta debug_token + phone_numbers', {
    previousWabaId: wabaId,
    discoveredWabaId: discovered,
    phoneNumberId: String(phoneNumberId)
  });
  try {
    await _persistWabaCanonical(connection, discovered);
  } catch (e) {
    logger.warn('[TemplateService] Could not persist WABA id correction', { message: e.message });
  }
  return discovered;
}

async function _fetchMessageTemplatesFromMeta(connection, wabaId, filters = {}) {
  const params = new URLSearchParams({
    fields: 'id,name,status,category,language,quality_score,components,parameter_format,rejected_reason',
    limit: '100'
  });
  if (filters.category) params.append('category', filters.category);
  const response = await axios.get(
    `${GRAPH_BASE}/${wabaId}/message_templates?${params.toString()}`,
    { headers: _authHeaders(connection) }
  );
  return response.data?.data || [];
}

/**
 * Normalize MIME for Meta Graph resumable upload (template header examples).
 * @see https://developers.facebook.com/docs/graph-api/guides/upload
 */
function _metaTemplateExampleFileType(mimetype, filename) {
  const raw = (mimetype || '').toLowerCase().trim();
  const ALLOWED = {
    'image/jpeg': 'image/jpeg',
    'image/jpg': 'image/jpg',
    'image/png': 'image/png',
    'video/mp4': 'video/mp4',
    'application/pdf': 'application/pdf'
  };
  if (ALLOWED[raw]) return ALLOWED[raw];
  const ext = path.extname(filename || '').toLowerCase();
  const FALLBACK = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.mp4': 'video/mp4',
    '.pdf': 'application/pdf'
  };
  return FALLBACK[ext] || null;
}

function _suggestedHeaderFormat(metaFileType) {
  if (!metaFileType) return null;
  if (metaFileType.startsWith('image/')) return 'IMAGE';
  if (metaFileType === 'video/mp4') return 'VIDEO';
  if (metaFileType === 'application/pdf') return 'DOCUMENT';
  return null;
}

/**
 * Upload file via Meta Resumable Upload API; returns handle `h` for message template HEADER examples.
 */
async function uploadHeaderExampleAsset(organizationId, connectionId, file) {
  const connection = await _resolveConnection(organizationId, connectionId);
  const appId =
    process.env.META_APP_ID ||
    process.env.FACEBOOK_APP_ID ||
    process.env.INSTAGRAM_APP_ID;

  if (!appId) {
    const err = new Error(
      'META_APP_ID (or FACEBOOK_APP_ID) is required to upload template media to Meta.'
    );
    err.statusCode = 500;
    throw err;
  }

  const buffer = file.buffer;
  if (!buffer?.length) {
    const err = new Error('Empty file.');
    err.statusCode = 400;
    throw err;
  }

  const origName = file.originalname || 'upload.bin';
  const metaFileType = _metaTemplateExampleFileType(file.mimetype, origName);

  if (!metaFileType) {
    const err = new Error(
      'Unsupported file type. Allowed: JPEG, PNG, MP4 (video), PDF — per Meta upload API.'
    );
    err.statusCode = 400;
    throw err;
  }

  const suggestedHeaderFormat = _suggestedHeaderFormat(metaFileType);
  const file_length = buffer.length;

  let sessionId;
  try {
    const params = new URLSearchParams({
      file_name: origName,
      file_length: String(file_length),
      file_type: metaFileType,
      access_token: _token(connection)
    });

    const r1 = await axios.post(
      `${GRAPH_BASE}/${appId}/uploads?${params.toString()}`,
      null,
      {
        headers: { Authorization: `Bearer ${_token(connection)}` },
        timeout: 60000
      }
    );
    sessionId = r1.data?.id;
    if (!sessionId) throw new Error('Meta did not return an upload session id.');
  } catch (error) {
    const parsed = _parseMetaError(error);
    logger.error('[TemplateService] Meta upload session error', parsed);
    const err = new Error(parsed.message);
    err.statusCode = parsed.statusCode;
    throw err;
  }

  let handle;
  try {
    const r2 = await axios.post(`${GRAPH_BASE}/${sessionId}`, buffer, {
      headers: {
        ..._authHeaderBinary(connection),
        file_offset: '0',
        'Content-Type': 'application/octet-stream'
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000
    });
    handle = r2.data?.h;
    if (!handle) throw new Error('Meta did not return a file handle (h).');
  } catch (error) {
    const parsed = _parseMetaError(error);
    logger.error('[TemplateService] Meta upload binary error', parsed);
    const err = new Error(parsed.message);
    err.statusCode = parsed.statusCode;
    throw err;
  }

  return { handle, fileType: metaFileType, suggestedHeaderFormat };
}

/** Auth header without forcing JSON Content-Type (binary upload step). */
function _authHeaderBinary(connection) {
  return { Authorization: `Bearer ${_token(connection)}` };
}

/** Validate template payload before sending to Meta (throws). */
function validateTemplatePayload({ name, category, language, components = [], parameter_format }) {
  const errors = [];

  if (!name) errors.push('Template name is required.');
  else if (!/^[a-z0-9_]+$/.test(name)) errors.push('Name must be lowercase alphanumeric with underscores only.');
  else if (name.length > 512) errors.push('Name must be 512 characters or fewer.');

  if (!['AUTHENTICATION', 'MARKETING', 'UTILITY'].includes(category)) {
    errors.push('Category must be AUTHENTICATION, MARKETING, or UTILITY.');
  }

  if (!language) errors.push('Language is required.');

  // Category-specific rules
  if (category === 'AUTHENTICATION') {
    const bodyComp = components.find(c => c.type === 'BODY');
    if (bodyComp && bodyComp.text) {
      errors.push('Authentication templates must not have a custom body text — it is generated by Meta.');
    }
    const buttonsComp = components.find(c => c.type === 'BUTTONS');
    if (buttonsComp) {
      const otpBtn = buttonsComp.buttons?.find(b => b.type === 'OTP');
      const copyBtn = buttonsComp.buttons?.find(b => b.type === 'COPY_CODE');
      if (!otpBtn && !copyBtn) {
        errors.push('Authentication templates require an OTP or COPY_CODE button.');
      }
    }
  }

  // Body length
  const body = components.find(c => c.type === 'BODY');
  if (body?.text && body.text.length > 1024) {
    errors.push('Body text must be 1024 characters or fewer.');
  }

  // Footer length
  const footer = components.find(c => c.type === 'FOOTER');
  if (footer?.text && footer.text.length > 60) {
    errors.push('Footer text must be 60 characters or fewer.');
  }

  // Button count
  const buttonsComp = components.find(c => c.type === 'BUTTONS');
  if (buttonsComp?.buttons?.length > 10) {
    errors.push('A template can have at most 10 buttons.');
  }

  // Quick-reply text length
  buttonsComp?.buttons?.forEach((btn, idx) => {
    if (btn.type === 'QUICK_REPLY' && btn.text?.length > 25) {
      errors.push(`Button ${idx + 1}: Quick reply text must be 25 characters or fewer.`);
    }
    if (btn.type === 'URL' && !btn.url) {
      errors.push(`Button ${idx + 1}: URL button requires a url field.`);
    }
    if (btn.type === 'PHONE_NUMBER' && !btn.phone_number) {
      errors.push(`Button ${idx + 1}: Phone number button requires a phone_number field.`);
    }
  });

  if (errors.length) {
    const err = new Error(errors.join(' | '));
    err.statusCode = 422;
    err.code = 'TEMPLATE_VALIDATION_ERROR';
    err.details = errors;
    throw err;
  }
}

// ── Service methods ───────────────────────────────────────────────────────────

/**
 * Create a new template on Meta and persist locally.
 */
async function createTemplate(organizationId, userId, connectionId, payload) {
  const { name, category, language, parameter_format = 'POSITIONAL', components = [] } = payload;

  // 1. Validate
  validateTemplatePayload({ name, category, language, components, parameter_format });

  // 2. Resolve WhatsApp connection
  const connection = await _resolveConnection(organizationId, connectionId);
  let wabaId = _wabaId(connection);

  if (!wabaId) {
    const err = new Error('WhatsApp Business Account ID is not configured for this connection.');
    err.statusCode = 400;
    throw err;
  }

  // 3. Build Meta payload
  const metaPayload = {
    name,
    category,
    language,
    parameter_format,
    components
  };

  // 4. Call Meta API (recover WABA id on 100/33)
  let metaResponse;
  try {
    const response = await axios.post(
      `${GRAPH_BASE}/${wabaId}/message_templates`,
      metaPayload,
      { headers: _authHeaders(connection) }
    );
    metaResponse = response.data;
  } catch (error) {
    const parsed = _parseMetaError(error);
    const recovered = await _recoverWabaIdIfNeeded(connection, wabaId, parsed);
    if (recovered) {
      wabaId = recovered;
      try {
        const response = await axios.post(
          `${GRAPH_BASE}/${wabaId}/message_templates`,
          metaPayload,
          { headers: _authHeaders(connection) }
        );
        metaResponse = response.data;
      } catch (err2) {
        const parsed2 = _parseMetaError(err2);
        logger.error('[TemplateService] Meta create template error', parsed2);
        const err = new Error(parsed2.message);
        err.statusCode = parsed2.statusCode;
        err.metaCode = parsed2.metaCode;
        throw err;
      }
    } else {
      logger.error('[TemplateService] Meta create template error', parsed);
      const err = new Error(parsed.message);
      err.statusCode = parsed.statusCode;
      err.metaCode = parsed.metaCode;
      throw err;
    }
  }

  // 5. Persist in DB
  const template = await WhatsAppTemplate.create({
    organization: organizationId,
    connection: connection._id,
    wabaId,
    metaTemplateId: metaResponse.id,
    name,
    category,
    language,
    parameter_format,
    components,
    status: metaResponse.status || 'IN_REVIEW',
    createdBy: userId
  });

  return template;
}

/**
 * List templates — from Meta (always fresh) with DB status sync.
 */
async function listTemplates(organizationId, connectionId = null, filters = {}) {
  const connection = await _resolveConnection(organizationId, connectionId);
  let wabaId = _wabaId(connection);

  if (!wabaId) {
    logger.error('[TemplateService] Cannot list templates: missing WABA id on connection', {
      connectionId: String(connection._id),
      platformDataKeys: Object.keys(connection.platformData || {})
    });
    const err = new Error(
      'WhatsApp Business Account ID is missing for this connection. Reconnect WhatsApp (Embedded Signup) or set WHATSAPP_BUSINESS_ACCOUNT_ID for env-based setup.'
    );
    err.statusCode = 400;
    err.code = 'MISSING_WABA_ID';
    throw err;
  }

  let metaTemplates = [];
  let fetchedFromMeta = false;

  try {
    metaTemplates = await _fetchMessageTemplatesFromMeta(connection, wabaId, filters);
    fetchedFromMeta = true;
  } catch (error) {
    const parsed = _parseMetaError(error);
    const recovered = await _recoverWabaIdIfNeeded(connection, wabaId, parsed);
    if (recovered) {
      wabaId = recovered;
      try {
        metaTemplates = await _fetchMessageTemplatesFromMeta(connection, wabaId, filters);
        fetchedFromMeta = true;
      } catch (err2) {
        const p2 = _parseMetaError(err2);
        logger.error('[TemplateService] Meta list templates error (after WABA recovery)', {
          ...p2,
          wabaIdUsed: wabaId,
          phoneNumberId: connection.platformData?.phoneNumberId
        });
      }
    } else {
      logger.error('[TemplateService] Meta list templates error', {
        ...parsed,
        wabaIdUsed: wabaId,
        connectionWabaId: connection.platformData?.wabaId,
        connectionBusinessAccountId: connection.platformData?.businessAccountId,
        phoneNumberId: connection.platformData?.phoneNumberId,
        ...(parsed.metaSubcode === 33
          ? {
              hint:
                'If Embedded Signup, ensure token has whatsapp_business_management; wrong WABA id is auto-corrected when phone number id is on the connection.'
            }
          : {})
      });
    }
  }

  if (!fetchedFromMeta) {
    const dbTemplates = await WhatsAppTemplate.find({
      organization: organizationId,
      connection: connection._id,
      isArchived: false
    })
      .sort({ createdAt: -1 })
      .lean();
    return { source: 'db_fallback', templates: dbTemplates };
  }

  _syncMetaTemplatesToDb(metaTemplates, organizationId, connection._id, wabaId).catch(() => {});

  return { source: 'meta', templates: metaTemplates };
}

/**
 * Get a single template detail from Meta.
 */
async function getTemplate(organizationId, connectionId, metaTemplateId) {
  const connection = await _resolveConnection(organizationId, connectionId);

  try {
    const response = await axios.get(
      `${GRAPH_BASE}/${metaTemplateId}?fields=id,name,status,category,language,quality_score,components,parameter_format,rejected_reason`,
      { headers: _authHeaders(connection) }
    );
    return response.data;
  } catch (error) {
    const parsed = _parseMetaError(error);
    const err = new Error(parsed.message);
    err.statusCode = parsed.statusCode;
    throw err;
  }
}

/**
 * Delete a template from Meta and soft-delete locally.
 */
async function deleteTemplate(organizationId, connectionId, metaTemplateId, templateName) {
  const connection = await _resolveConnection(organizationId, connectionId);
  let wabaId = _wabaId(connection);

  const doDelete = async (id) =>
    axios.delete(
      `${GRAPH_BASE}/${id}/message_templates?hsm_id=${metaTemplateId}&name=${encodeURIComponent(templateName)}`,
      { headers: _authHeaders(connection) }
    );

  try {
    await doDelete(wabaId);
  } catch (error) {
    let parsed = _parseMetaError(error);
    const recovered = await _recoverWabaIdIfNeeded(connection, wabaId, parsed);
    if (recovered) {
      wabaId = recovered;
      try {
        await doDelete(wabaId);
      } catch (err2) {
        parsed = _parseMetaError(err2);
        if (parsed.metaCode !== 100) {
          const err = new Error(parsed.message);
          err.statusCode = parsed.statusCode;
          throw err;
        }
      }
    } else if (parsed.metaCode !== 100) {
      const err = new Error(parsed.message);
      err.statusCode = parsed.statusCode;
      throw err;
    }
    // 100 = template or waba object does not exist — still soft-delete locally
  }

  await WhatsAppTemplate.findOneAndUpdate(
    { organization: organizationId, metaTemplateId },
    { isArchived: true, status: 'DELETED' }
  );

  return { deleted: true };
}

/**
 * Sync Meta template list into our DB (status, quality score).
 * @private
 */
async function _syncMetaTemplatesToDb(metaTemplates, organizationId, connectionId, wabaId) {
  const ops = metaTemplates.map(t => ({
    updateOne: {
      filter: { organization: organizationId, metaTemplateId: t.id },
      update: {
        $set: {
          status: t.status,
          qualityScore: t.quality_score?.score || 'UNKNOWN',
          rejectedReason: t.rejected_reason || null,
          metaStatusUpdatedAt: new Date(),
          wabaId,
          connection: connectionId
        },
        $setOnInsert: {
          organization: organizationId,
          connection: connectionId,
          name: t.name,
          category: t.category,
          language: t.language,
          parameter_format: t.parameter_format || 'POSITIONAL',
          components: t.components || [],
          metaTemplateId: t.id,
          createdBy: null,
          wabaId
        }
      },
      upsert: true
    }
  }));

  if (ops.length) await WhatsAppTemplate.bulkWrite(ops);
}

/**
 * Handle incoming webhook status update for a template.
 * Called from the webhook controller when `message_template_status_update` is received.
 */
async function handleTemplateStatusWebhook(event) {
  const { message_template_id, message_template_name, event: status, reason } = event;
  if (!message_template_id) return;

  await WhatsAppTemplate.updateMany(
    { metaTemplateId: String(message_template_id) },
    {
      $set: {
        status,
        rejectedReason: reason || null,
        metaStatusUpdatedAt: new Date()
      }
    }
  );

  logger.info('[TemplateService] Template status updated via webhook', {
    metaTemplateId: message_template_id,
    status,
    name: message_template_name
  });
}

module.exports = {
  createTemplate,
  listTemplates,
  getTemplate,
  deleteTemplate,
  uploadHeaderExampleAsset,
  handleTemplateStatusWebhook,
  validateTemplatePayload
};
