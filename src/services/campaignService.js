/**
 * Campaign Service
 *
 * All business logic for WhatsApp broadcast campaigns:
 * CRUD, recipient bulk-insert, launch/pause/resume/cancel, test send.
 */

const mongoose = require('mongoose');
const WhatsAppCampaign = require('../models/WhatsAppCampaign');
const WhatsAppCampaignRecipient = require('../models/WhatsAppCampaignRecipient');
const WhatsAppTemplate = require('../models/WhatsAppTemplate');
const PlatformConnection = require('../models/PlatformConnection');
const whatsappService = require('../integrations/whatsapp/whatsappService');
const { campaignSendQueue, queueConfig } = require('../config/queue');
const logger = require('../config/logger');
const { deriveTemplateSlots, flattenSlotKeys } = require('../utils/whatsappTemplateSlots');
const {
  buildRecipientComponents,
  assertCampaignReadyForTemplate
} = require('../utils/whatsappCampaignBuilder');
const { parseCsv, looksLikeHeaderRow } = require('../utils/csvParser');

// Statuses that allow editing
const EDITABLE_STATUSES = ['draft'];
// Statuses that are considered "terminal"
const TERMINAL_STATUSES = ['completed', 'cancelled', 'failed'];

/** 24-char hex Mongo ObjectId */
function isMongoObjectIdString(value) {
  return /^[a-fA-F0-9]{24}$/.test(String(value || ''));
}

/**
 * Campaign.templateRef must be a WhatsAppTemplate document _id.
 * Clients may send a Mongo id (from our API) or a Meta message template id (from Graph);
 * resolve either to the local document for this org + connection.
 */
async function resolveWhatsAppTemplateRef(orgId, connectionId, templateRef) {
  if (templateRef == null || templateRef === '') return undefined;
  const raw =
    typeof templateRef === 'object' && templateRef != null && 'toString' in templateRef
      ? templateRef.toString()
      : String(templateRef);

  if (isMongoObjectIdString(raw)) {
    const doc = await WhatsAppTemplate.findOne({ _id: raw, organization: orgId }).select('_id').lean();
    return doc?._id;
  }

  const byMeta = await WhatsAppTemplate.findOne({
    organization: orgId,
    connection: connectionId,
    metaTemplateId: raw
  })
    .select('_id')
    .lean();
  return byMeta?._id;
}

/** Meta delivery progression rank — never downgrade except to failed */
const DELIVERY_RANK = { pending: 0, sent: 1, delivered: 2, read: 3, failed: -1 };

/**
 * Unified report label for a recipient row (processed on backend for consistent UI).
 */
function computeRecipientReportStatus(r) {
  if (!r) return 'pending';
  if (r.status === 'pending') return 'pending';
  if (r.status === 'failed') return 'failed';
  if (r.deliveryStatus === 'failed') return 'failed';
  if (r.repliedAt) return 'replied';
  if (r.deliveryStatus === 'read') return 'read';
  if (r.deliveryStatus === 'delivered') return 'delivered';
  if (r.status === 'sent') return 'sent';
  return 'pending';
}

function buildReportStatusQuery(reportStatus) {
  if (!reportStatus) return null;
  switch (reportStatus) {
    case 'pending':
      return { status: 'pending' };
    case 'failed':
      return { $or: [{ status: 'failed' }, { deliveryStatus: 'failed' }] };
    case 'sent':
      return {
        status: 'sent',
        deliveryStatus: { $in: ['pending', 'sent'] },
        repliedAt: { $exists: false }
      };
    case 'delivered':
      return { status: 'sent', deliveryStatus: 'delivered', repliedAt: { $exists: false } };
    case 'read':
      return { status: 'sent', deliveryStatus: 'read', repliedAt: { $exists: false } };
    case 'replied':
      return { repliedAt: { $exists: true, $ne: null } };
    default:
      return null;
  }
}

/**
 * Apply WhatsApp Cloud API delivery status webhook to the matching campaign recipient.
 */
async function applyRecipientDeliveryStatus(messageId, newStatus, timestamp, errorDetail) {
  if (!messageId || !newStatus) return;

  const doc = await WhatsAppCampaignRecipient.findOne({ messageId }).select('deliveryStatus').lean();
  if (!doc) return;

  const at = timestamp ? new Date(parseInt(timestamp, 10) * 1000) : new Date();

  if (newStatus === 'failed') {
    await WhatsAppCampaignRecipient.updateOne(
      { messageId },
      {
        $set: {
          deliveryStatus: 'failed',
          deliveryStatusAt: at,
          ...(errorDetail ? { deliveryError: String(errorDetail).substring(0, 500) } : {})
        }
      }
    );
    return;
  }

  const current = doc.deliveryStatus || 'pending';
  const currentRank = DELIVERY_RANK[current] ?? 0;
  const newRank = DELIVERY_RANK[newStatus] ?? 0;
  if (newRank <= currentRank) return;

  await WhatsAppCampaignRecipient.updateOne(
    { messageId },
    { $set: { deliveryStatus: newStatus, deliveryStatusAt: at } }
  );
}

/**
 * Mark the most recent sent campaign message to this phone as replied (inbound webhook).
 */
async function markRecipientReplied({ orgId, phone }) {
  if (!orgId || !phone) return;

  const normalized = normalizePhone(phone) || String(phone).replace(/\D/g, '');
  if (!normalized) return;

  await WhatsAppCampaignRecipient.findOneAndUpdate(
    {
      organization: orgId,
      phone: normalized,
      status: 'sent',
      repliedAt: { $exists: false }
    },
    { $set: { repliedAt: new Date() } },
    { sort: { sentAt: -1 } }
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise a raw phone string to E.164 digits-only.
 * Returns null if the number cannot be normalised (too short / non-numeric).
 */
function normalizePhone(raw) {
  if (!raw) return null;
  // Strip common formatting characters
  let digits = String(raw).replace(/[\s\-().+]/g, '');
  // Keep only digits
  digits = digits.replace(/\D/g, '');
  // Minimum 7 digits, maximum 15
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

/**
 * Parse a newline-separated list of phone numbers OR a CSV text blob.
 * CSV format: first column = phone, optional second column = name.
 * Returns { phones: [{phone, recipientName}], skipped: number }
 */
function parsePhoneInput(rawText) {
  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const results = [];
  let skipped = 0;

  for (const line of lines) {
    const parts = line.split(',');
    const rawPhone = (parts[0] || '').trim();
    const recipientName = (parts[1] || '').trim() || undefined;

    const phone = normalizePhone(rawPhone);
    if (!phone) {
      skipped++;
      continue;
    }
    results.push({ phone, recipientName });
  }

  return { phones: results, skipped };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

async function createCampaign({ orgId, userId, name, connectionId, templateRefId }) {
  // Verify the connection belongs to this org and is WhatsApp
  const connection = await PlatformConnection.findOne({
    _id: connectionId,
    organization: orgId,
    platform: 'whatsapp',
    isActive: true
  }).lean();
  if (!connection) {
    const err = new Error('WhatsApp connection not found or inactive');
    err.statusCode = 400;
    throw err;
  }

  let templateRef;
  if (templateRefId) {
    templateRef = await resolveWhatsAppTemplateRef(orgId, connectionId, templateRefId);
    if (!templateRef) {
      const err = new Error('templateRefId does not match a known template for this connection');
      err.statusCode = 400;
      throw err;
    }
  }

  const campaign = await WhatsAppCampaign.create({
    organization: orgId,
    connection: connectionId,
    name,
    templateRef: templateRef || undefined,
    status: 'draft',
    createdBy: userId
  });

  return campaign;
}

async function listCampaigns({ orgId, page = 1, limit = 20, status }) {
  const query = { organization: orgId };
  if (status) query.status = status;

  const skip = (page - 1) * limit;
  const [campaigns, total] = await Promise.all([
    WhatsAppCampaign.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('templateRef', 'name category language status')
      .populate('connection', 'platformDisplayName platformData.displayPhoneNumber')
      .lean(),
    WhatsAppCampaign.countDocuments(query)
  ]);

  return { campaigns, total, page, limit };
}

async function getCampaign({ orgId, campaignId }) {
  const campaign = await WhatsAppCampaign.findOne({ _id: campaignId, organization: orgId })
    .populate('templateRef', 'name category language status components')
    .populate('connection', 'platformDisplayName platformData')
    .lean();
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }
  return campaign;
}

async function updateCampaign({ orgId, campaignId, updates }) {
  const campaign = await WhatsAppCampaign.findOne({ _id: campaignId, organization: orgId });
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }
  if (!EDITABLE_STATUSES.includes(campaign.status)) {
    const err = new Error(`Cannot edit a campaign in '${campaign.status}' status`);
    err.statusCode = 400;
    throw err;
  }

  const allowed = [
    'name',
    'templateRef',
    'scheduledAt',
    'connection',
    'headerMedia',
    'headerLocation',
    'urlButtonParams',
    'variableMapping'
  ];
  for (const key of allowed) {
    if (updates[key] === undefined) continue;

    if (key === 'templateRef') {
      // Allow explicit null/empty to clear the templateRef
      if (updates.templateRef === null || updates.templateRef === '') {
        campaign.templateRef = undefined;
        // Also clear template-specific campaign-level params so we don't carry stale state
        campaign.headerMedia = undefined;
        campaign.headerLocation = undefined;
        campaign.urlButtonParams = [];
        campaign.variableMapping = undefined;
        continue;
      }
      const resolved = await resolveWhatsAppTemplateRef(
        orgId,
        campaign.connection,
        updates.templateRef
      );
      if (!resolved) {
        const err = new Error(
          'Template not found. Sync templates for this WhatsApp number, then select the template again.'
        );
        err.statusCode = 400;
        throw err;
      }
      campaign.templateRef = resolved;
      continue;
    }

    if (key === 'headerMedia') {
      campaign.headerMedia = sanitizeHeaderMedia(updates.headerMedia);
      continue;
    }
    if (key === 'headerLocation') {
      campaign.headerLocation = sanitizeHeaderLocation(updates.headerLocation);
      continue;
    }
    if (key === 'urlButtonParams') {
      campaign.urlButtonParams = sanitizeUrlButtonParams(updates.urlButtonParams);
      continue;
    }
    if (key === 'variableMapping') {
      campaign.variableMapping = sanitizeVariableMapping(updates.variableMapping);
      continue;
    }

    campaign[key] = updates[key];
  }

  await campaign.save();
  return campaign;
}

// ─── Update-payload normalisers ───────────────────────────────────────────────

function sanitizeHeaderMedia(input) {
  if (input == null || input === '') return undefined;
  if (typeof input !== 'object') return undefined;
  const kind = String(input.kind || '').toUpperCase();
  if (!['IMAGE', 'VIDEO', 'DOCUMENT'].includes(kind)) return undefined;
  const url = String(input.url || '').trim();
  if (!url) return undefined;
  const out = { kind, url: url.slice(0, 2048) };
  if (input.filename) out.filename = String(input.filename).trim().slice(0, 256);
  if (input.mediaLibraryId && /^[a-fA-F0-9]{24}$/.test(String(input.mediaLibraryId))) {
    out.mediaLibraryId = input.mediaLibraryId;
  }
  return out;
}

function sanitizeHeaderLocation(input) {
  if (input == null || input === '') return undefined;
  if (typeof input !== 'object') return undefined;
  const lat = Number(input.latitude);
  const lng = Number(input.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return {
    latitude: lat,
    longitude: lng,
    name: input.name ? String(input.name).trim().slice(0, 200) : undefined,
    address: input.address ? String(input.address).trim().slice(0, 500) : undefined
  };
}

function sanitizeUrlButtonParams(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const p of input) {
    if (!p || typeof p !== 'object') continue;
    const idx = Number(p.index);
    if (!Number.isInteger(idx) || idx < 0 || idx > 9 || seen.has(idx)) continue;
    seen.add(idx);
    out.push({ index: idx, value: String(p.value || '').slice(0, 500) });
  }
  return out;
}

function sanitizeVariableMapping(input) {
  if (input == null) return undefined;
  if (typeof input !== 'object') return undefined;
  const out = {};
  if (input.phoneColumn) out.phoneColumn = String(input.phoneColumn).slice(0, 100);
  if (input.nameColumn) out.nameColumn = String(input.nameColumn).slice(0, 100);
  if (input.slots && typeof input.slots === 'object') {
    out.slots = {};
    for (const k of Object.keys(input.slots)) {
      out.slots[String(k).slice(0, 100)] = String(input.slots[k] || '').slice(0, 100);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

async function deleteCampaign({ orgId, campaignId }) {
  const campaign = await WhatsAppCampaign.findOne({ _id: campaignId, organization: orgId });
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }
  if (campaign.status === 'running') {
    const err = new Error('Cannot delete a running campaign. Pause or cancel it first.');
    err.statusCode = 400;
    throw err;
  }

  await WhatsAppCampaignRecipient.deleteMany({ campaign: campaignId });
  await campaign.deleteOne();
  return { deleted: true };
}

// ─── Template slots / CSV preview ────────────────────────────────────────────

/**
 * Return the template slot descriptor for the campaign's current template.
 * Used by the editor to render the right inputs (text vars / media / location / URL button vars).
 */
async function getTemplateSlotsForCampaign({ orgId, campaignId }) {
  const campaign = await WhatsAppCampaign.findOne({ _id: campaignId, organization: orgId })
    .select('templateRef')
    .lean();
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }
  if (!campaign.templateRef) {
    return { slots: null, hasTemplate: false };
  }
  const template = await WhatsAppTemplate.findById(campaign.templateRef).lean();
  if (!template) {
    return { slots: null, hasTemplate: false };
  }
  return {
    slots: deriveTemplateSlots(template),
    hasTemplate: true,
    template: {
      _id: String(template._id),
      name: template.name,
      language: template.language,
      category: template.category,
      parameter_format: template.parameter_format,
      components: template.components
    }
  };
}

/** Normalise a header for fuzzy matching: lowercase, strip non-alphanumeric. */
function normalizeHeaderKey(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Guess the best CSV column for the phone field — `phone`, `mobile`, `whatsapp`, `number`.
 */
function detectPhoneColumn(headers) {
  const candidates = ['phone', 'mobile', 'whatsapp', 'whatsappnumber', 'number', 'phonenumber', 'msisdn', 'contact'];
  for (const cand of candidates) {
    const found = headers.find((h) => normalizeHeaderKey(h) === cand);
    if (found) return found;
  }
  // Fallback: first header whose key contains 'phone' / 'mob'
  return headers.find((h) => /phone|mob/i.test(h)) || headers[0] || null;
}

/** Guess the best CSV column for a friendly display name. */
function detectNameColumn(headers, phoneColumn) {
  const candidates = ['name', 'firstname', 'fullname', 'customername', 'recipientname', 'displayname'];
  for (const cand of candidates) {
    const found = headers.find((h) => normalizeHeaderKey(h) === cand);
    if (found && found !== phoneColumn) return found;
  }
  return headers.find((h) => /name/i.test(h) && h !== phoneColumn) || null;
}

/** Map each template slot to the most likely CSV column (or null). */
function suggestSlotMapping(headers, slots) {
  const out = {};
  if (!slots) return out;
  const norm = (s) => normalizeHeaderKey(s);
  const headerKeys = headers.map((h) => ({ raw: h, key: norm(h) }));

  const allSlots = [
    ...(slots.header?.textSlots || []),
    ...(slots.body?.slots || []),
    ...(slots.buttons || []).flatMap((b) => b.urlVars || [])
  ];

  for (const slot of allSlots) {
    // Prefer named match (slot.name) → exact key match on a CSV header
    if (slot.name) {
      const k = norm(slot.name);
      const match = headerKeys.find((h) => h.key === k);
      if (match) {
        out[slot.key] = match.raw;
        continue;
      }
      // Partial contains
      const partial = headerKeys.find((h) => h.key.includes(k) || k.includes(h.key));
      if (partial) {
        out[slot.key] = partial.raw;
        continue;
      }
    }
    // Positional fallback: nothing to suggest reliably
    out[slot.key] = null;
  }
  return out;
}

/**
 * Preview a CSV the user just uploaded for this campaign.
 * Returns headers, the first ~5 sample rows, and a suggested column → slot mapping.
 */
async function previewRecipientCsv({ orgId, campaignId, rawText }) {
  const campaign = await WhatsAppCampaign.findOne({ _id: campaignId, organization: orgId })
    .select('templateRef')
    .lean();
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }
  if (!rawText || !String(rawText).trim()) {
    const err = new Error('Please provide CSV text to preview.');
    err.statusCode = 400;
    throw err;
  }

  const hasHeader = looksLikeHeaderRow(rawText);
  const parsed = parseCsv(rawText, { hasHeader });

  // If there are no headers (numbers-only file), synthesize sensible names
  let headers = parsed.headers;
  let rows = parsed.rows;
  if (!hasHeader && rows.length) {
    const cols = rows[0]?.length || 0;
    headers = Array.from({ length: cols }, (_, i) => (i === 0 ? 'phone' : i === 1 ? 'name' : `column_${i + 1}`));
  }

  // Surface a slot mapping suggestion only when the campaign already has a template
  let slots = null;
  if (campaign.templateRef) {
    const template = await WhatsAppTemplate.findById(campaign.templateRef).lean();
    if (template) slots = deriveTemplateSlots(template);
  }

  const phoneColumn = detectPhoneColumn(headers);
  const nameColumn = detectNameColumn(headers, phoneColumn);
  const suggestedSlotMapping = slots ? suggestSlotMapping(headers, slots) : {};

  return {
    hasHeader,
    headers,
    rowCount: rows.length,
    sampleRows: rows.slice(0, 5),
    suggestedMapping: {
      phoneColumn,
      nameColumn,
      slots: suggestedSlotMapping
    },
    slots
  };
}

/**
 * Add recipients using an explicit CSV-column → template-slot mapping.
 * Replaces the simpler `addRecipients` path when the template has variables.
 *
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {string} opts.campaignId
 * @param {string} opts.rawText
 * @param {object} [opts.mapping]   { phoneColumn, nameColumn?, slots: { slotKey: csvHeader } }
 * @param {object} [opts.defaultParams] - slotKey → fallback string used when the row's cell is empty
 */
async function addRecipientsWithMapping({ orgId, campaignId, rawText, mapping, defaultParams }) {
  const campaign = await WhatsAppCampaign.findOne({ _id: campaignId, organization: orgId });
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }
  if (!EDITABLE_STATUSES.includes(campaign.status)) {
    const err = new Error(`Cannot modify recipients of a campaign in '${campaign.status}' status`);
    err.statusCode = 400;
    throw err;
  }
  if (!rawText || !String(rawText).trim()) {
    const err = new Error('No CSV text provided');
    err.statusCode = 400;
    throw err;
  }

  const hasHeader = looksLikeHeaderRow(rawText);
  const parsed = parseCsv(rawText, { hasHeader });

  // Synthesize headers for header-less input
  let { headers, rows } = parsed;
  if (!hasHeader) {
    const cols = rows[0]?.length || 0;
    headers = Array.from({ length: cols }, (_, i) => (i === 0 ? 'phone' : i === 1 ? 'name' : `column_${i + 1}`));
  }
  if (!rows.length) {
    const err = new Error('CSV is empty');
    err.statusCode = 400;
    throw err;
  }

  // Resolve template slots (if any)
  let slots = null;
  let template = null;
  if (campaign.templateRef) {
    template = await WhatsAppTemplate.findById(campaign.templateRef).lean();
    if (template) slots = deriveTemplateSlots(template);
  }

  const requiredSlots = slots ? flattenSlotKeys(slots) : [];

  const phoneColumn =
    (mapping && mapping.phoneColumn) || detectPhoneColumn(headers);
  const nameColumn = (mapping && mapping.nameColumn) || detectNameColumn(headers, phoneColumn);
  const slotMap = (mapping && mapping.slots) || {};

  if (!phoneColumn || !headers.includes(phoneColumn)) {
    const err = new Error('Phone column is required and must match a CSV header.');
    err.statusCode = 400;
    throw err;
  }

  // Validate: every required slot must either have a mapped column OR a defaultParams entry
  const defaults = (defaultParams && typeof defaultParams === 'object') ? defaultParams : {};
  const unmapped = [];
  for (const slotKey of requiredSlots) {
    const mappedCol = slotMap[slotKey];
    const colExists = mappedCol && headers.includes(mappedCol);
    const hasDefault = defaults[slotKey] != null && String(defaults[slotKey]).trim() !== '';
    if (!colExists && !hasDefault) unmapped.push(slotKey);
  }
  if (unmapped.length) {
    const err = new Error(
      `Missing value for template variable(s): ${unmapped.join(', ')}.  ` +
      'Either map a CSV column or provide a default value.'
    );
    err.statusCode = 400;
    throw err;
  }

  // Build header index map for fast column lookup
  const colIndex = {};
  headers.forEach((h, i) => { colIndex[h] = i; });

  const phoneIdx = colIndex[phoneColumn];
  const nameIdx = nameColumn ? colIndex[nameColumn] : -1;

  const docs = [];
  let skipped = 0;
  for (const row of rows) {
    const rawPhone = row[phoneIdx] || '';
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      skipped++;
      continue;
    }
    const recipientName = nameIdx >= 0 ? String(row[nameIdx] || '').trim() || undefined : undefined;

    // Per-recipient template params
    const templateParams = {};
    for (const slotKey of requiredSlots) {
      const col = slotMap[slotKey];
      let value = '';
      if (col && colIndex[col] !== undefined) {
        value = String(row[colIndex[col]] || '').trim();
      }
      if (!value && defaults[slotKey] != null) {
        value = String(defaults[slotKey] || '').trim();
      }
      templateParams[slotKey] = value;
    }

    docs.push({
      campaign: campaignId,
      organization: orgId,
      phone,
      recipientName,
      status: 'pending',
      templateParams: requiredSlots.length ? templateParams : undefined
    });
  }

  if (!docs.length) {
    const err = new Error('No valid phone numbers found in the CSV');
    err.statusCode = 400;
    throw err;
  }

  const result = await WhatsAppCampaignRecipient.insertMany(docs, {
    ordered: false,
    rawResult: true
  }).catch(err => {
    if (err.code === 11000 || err.name === 'BulkWriteError') {
      return err.result || { insertedCount: err.insertedDocs?.length || 0 };
    }
    throw err;
  });

  const inserted = result.insertedCount || 0;
  const duplicates = docs.length - inserted;

  // Persist the mapping on the campaign for reference + recompute totals
  const total = await WhatsAppCampaignRecipient.countDocuments({ campaign: campaignId });
  await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
    $set: {
      'stats.total': total,
      'stats.pending': total,
      variableMapping: sanitizeVariableMapping({
        phoneColumn,
        nameColumn,
        slots: slotMap
      })
    }
  });

  return { inserted, duplicates, skipped, total };
}

// ─── Recipients ───────────────────────────────────────────────────────────────

/**
 * Bulk-insert recipients from pasted text or CSV content.
 * Idempotent: duplicate phones for the same campaign are ignored.
 */
async function addRecipients({ orgId, campaignId, rawText }) {
  const campaign = await WhatsAppCampaign.findOne({ _id: campaignId, organization: orgId });
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }
  if (!EDITABLE_STATUSES.includes(campaign.status)) {
    const err = new Error(`Cannot modify recipients of a campaign in '${campaign.status}' status`);
    err.statusCode = 400;
    throw err;
  }

  const { phones, skipped } = parsePhoneInput(rawText);
  if (phones.length === 0) {
    const err = new Error('No valid phone numbers found in the provided input');
    err.statusCode = 400;
    throw err;
  }

  // Bulk insert, ignoring duplicate phone+campaign pairs
  const docs = phones.map(({ phone, recipientName }) => ({
    campaign: campaignId,
    organization: orgId,
    phone,
    recipientName,
    status: 'pending'
  }));

  const result = await WhatsAppCampaignRecipient.insertMany(docs, {
    ordered: false,   // continue on duplicate key errors
    rawResult: true
  }).catch(err => {
    // E11000 = duplicate key; extract the result from the partial insert
    if (err.code === 11000 || err.name === 'BulkWriteError') {
      return err.result || { insertedCount: err.insertedDocs?.length || 0 };
    }
    throw err;
  });

  const inserted = result.insertedCount || 0;
  const duplicates = phones.length - inserted;

  // Update campaign total
  const total = await WhatsAppCampaignRecipient.countDocuments({ campaign: campaignId });
  await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
    $set: { 'stats.total': total, 'stats.pending': total }
  });

  return { inserted, duplicates, skipped, total };
}

async function getRecipients({ orgId, campaignId, page = 1, limit = 50, status }) {
  const query = { campaign: campaignId, organization: orgId };
  if (status) query.status = status;

  const skip = (page - 1) * limit;
  const [recipients, total] = await Promise.all([
    WhatsAppCampaignRecipient.find(query)
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    WhatsAppCampaignRecipient.countDocuments(query)
  ]);

  return { recipients, total, page, limit };
}

/**
 * Paginated recipient report with delivery/read/reply summary for a campaign.
 */
async function getRecipientsReport({
  orgId,
  campaignId,
  page = 1,
  limit = 50,
  reportStatus,
  search
}) {
  const campaign = await WhatsAppCampaign.findOne({ _id: campaignId, organization: orgId })
    .select('_id name stats')
    .lean();
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }

  const campaignOid = new mongoose.Types.ObjectId(campaignId);
  const orgOid = new mongoose.Types.ObjectId(orgId);
  const baseMatch = { campaign: campaignOid, organization: orgOid };

  const statusFilter = buildReportStatusQuery(reportStatus);
  const listQuery = { ...baseMatch };
  if (statusFilter) Object.assign(listQuery, statusFilter);
  if (search && String(search).trim()) {
    const term = String(search).trim().replace(/\D/g, '');
    if (term) listQuery.phone = { $regex: term };
  }

  const skip = (page - 1) * limit;

  const [
    summaryTotal,
    summaryPending,
    summaryFailed,
    summarySent,
    summaryDelivered,
    summaryRead,
    summaryReplied,
    recipients,
    total
  ] = await Promise.all([
    WhatsAppCampaignRecipient.countDocuments(baseMatch),
    WhatsAppCampaignRecipient.countDocuments({ ...baseMatch, status: 'pending' }),
    WhatsAppCampaignRecipient.countDocuments({
      ...baseMatch,
      $or: [{ status: 'failed' }, { deliveryStatus: 'failed' }]
    }),
    WhatsAppCampaignRecipient.countDocuments({
      ...baseMatch,
      status: 'sent',
      deliveryStatus: { $in: ['pending', 'sent'] },
      repliedAt: { $exists: false }
    }),
    WhatsAppCampaignRecipient.countDocuments({
      ...baseMatch,
      status: 'sent',
      deliveryStatus: 'delivered',
      repliedAt: { $exists: false }
    }),
    WhatsAppCampaignRecipient.countDocuments({
      ...baseMatch,
      status: 'sent',
      deliveryStatus: 'read',
      repliedAt: { $exists: false }
    }),
    WhatsAppCampaignRecipient.countDocuments({
      ...baseMatch,
      repliedAt: { $exists: true, $ne: null }
    }),
    WhatsAppCampaignRecipient.find(listQuery)
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    WhatsAppCampaignRecipient.countDocuments(listQuery)
  ]);

  const enriched = recipients.map(r => ({
    ...r,
    reportStatus: computeRecipientReportStatus(r)
  }));

  return {
    campaign: { _id: campaign._id, name: campaign.name, stats: campaign.stats },
    summary: {
      total: summaryTotal,
      pending: summaryPending,
      failed: summaryFailed,
      sent: summarySent,
      delivered: summaryDelivered,
      read: summaryRead,
      replied: summaryReplied
    },
    recipients: enriched,
    total,
    page,
    limit
  };
}

async function clearRecipients({ orgId, campaignId }) {
  const campaign = await WhatsAppCampaign.findOne({ _id: campaignId, organization: orgId });
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }
  if (!EDITABLE_STATUSES.includes(campaign.status)) {
    const err = new Error(`Cannot clear recipients of a campaign in '${campaign.status}' status`);
    err.statusCode = 400;
    throw err;
  }

  await WhatsAppCampaignRecipient.deleteMany({ campaign: campaignId });
  await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
    $set: { 'stats.total': 0, 'stats.pending': 0 }
  });
  return { cleared: true };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

async function launchCampaign({ orgId, campaignId /* templateComponents intentionally ignored — per-recipient build at send time */ }) {
  const campaign = await WhatsAppCampaign.findOne({ _id: campaignId, organization: orgId });
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }
  if (!EDITABLE_STATUSES.includes(campaign.status)) {
    const err = new Error(`Campaign is already in '${campaign.status}' status`);
    err.statusCode = 400;
    throw err;
  }

  // Validate template
  if (!campaign.templateRef) {
    const err = new Error('Please select a template before launching');
    err.statusCode = 400;
    throw err;
  }

  const template = await WhatsAppTemplate.findById(campaign.templateRef).lean();
  if (!template || template.status !== 'APPROVED') {
    const err = new Error('Selected template is not approved by Meta');
    err.statusCode = 400;
    throw err;
  }

  // Campaign-level validation: media/location/auth/unsupported guards
  assertCampaignReadyForTemplate(template, campaign.toObject ? campaign.toObject() : campaign);

  const total = await WhatsAppCampaignRecipient.countDocuments({ campaign: campaignId });
  if (total === 0) {
    const err = new Error('No recipients added. Please add at least one phone number.');
    err.statusCode = 400;
    throw err;
  }

  // Freeze the full template definition so the worker can build per-recipient components
  campaign.templateSnapshot = {
    name: template.name,
    languageCode: template.language,
    definition: template,
    parameterFormat: template.parameter_format === 'NAMED' ? 'NAMED' : 'POSITIONAL',
    components: []
  };
  campaign.stats.total = total;
  campaign.stats.pending = total;
  campaign.stats.sent = 0;
  campaign.stats.failed = 0;

  const isScheduled = campaign.scheduledAt && campaign.scheduledAt > new Date();

  if (isScheduled) {
    campaign.status = 'scheduled';
    await campaign.save();
    logger.info('[Campaign] Scheduled for later send', { campaignId, scheduledAt: campaign.scheduledAt });
    return campaign;
  }

  // Send immediately
  campaign.status = 'running';
  campaign.startedAt = new Date();
  await campaign.save();

  await campaignSendQueue.add(
    { type: 'send', campaignId: campaignId.toString() },
    { ...queueConfig, jobId: `campaign-send-${campaignId}` }
  );

  logger.info('[Campaign] Launched immediately', { campaignId, total });
  return campaign;
}

async function pauseCampaign({ orgId, campaignId }) {
  const campaign = await WhatsAppCampaign.findOneAndUpdate(
    { _id: campaignId, organization: orgId, status: 'running' },
    { $set: { status: 'paused' } },
    { new: true }
  );
  if (!campaign) {
    const err = new Error('Campaign not found or not in running state');
    err.statusCode = 404;
    throw err;
  }
  return campaign;
}

async function resumeCampaign({ orgId, campaignId }) {
  const campaign = await WhatsAppCampaign.findOneAndUpdate(
    { _id: campaignId, organization: orgId, status: 'paused' },
    { $set: { status: 'running' } },
    { new: true }
  );
  if (!campaign) {
    const err = new Error('Campaign not found or not in paused state');
    err.statusCode = 404;
    throw err;
  }

  // Re-enqueue the send job
  await campaignSendQueue.add(
    { type: 'send', campaignId: campaignId.toString() },
    { ...queueConfig, jobId: `campaign-send-${campaignId}-resume-${Date.now()}` }
  );

  return campaign;
}

async function cancelCampaign({ orgId, campaignId }) {
  const campaign = await WhatsAppCampaign.findOne({ _id: campaignId, organization: orgId });
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }
  if (TERMINAL_STATUSES.includes(campaign.status)) {
    const err = new Error(`Campaign is already in '${campaign.status}' status`);
    err.statusCode = 400;
    throw err;
  }

  campaign.status = 'cancelled';
  campaign.finishedAt = new Date();
  await campaign.save();
  return campaign;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

async function getCampaignStats({ orgId, campaignId }) {
  const campaign = await WhatsAppCampaign.findOne({ _id: campaignId, organization: orgId })
    .select('stats status')
    .lean();
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }

  // Recompute from recipient collection for accuracy
  const agg = await WhatsAppCampaignRecipient.aggregate([
    { $match: { campaign: campaign._id } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);

  const map = {};
  agg.forEach(a => { map[a._id] = a.count; });

  return {
    status: campaign.status,
    total: (map.pending || 0) + (map.sent || 0) + (map.failed || 0),
    sent: map.sent || 0,
    failed: map.failed || 0,
    pending: map.pending || 0
  };
}

// ─── Test send ────────────────────────────────────────────────────────────────

async function sendTestMessage({ orgId, campaignId, testPhone, testParams }) {
  // Load campaign and full template (need .components for slot derivation)
  const campaign = await WhatsAppCampaign.findOne({ _id: campaignId, organization: orgId }).lean();
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }
  if (!campaign.templateRef) {
    const err = new Error('Please select a template first');
    err.statusCode = 400;
    throw err;
  }

  const template = await WhatsAppTemplate.findById(campaign.templateRef).lean();
  if (!template) {
    const err = new Error('Template not found');
    err.statusCode = 400;
    throw err;
  }
  if (template.status !== 'APPROVED') {
    const err = new Error('Template is not approved by Meta');
    err.statusCode = 400;
    throw err;
  }
  assertCampaignReadyForTemplate(template, campaign);

  const phone = normalizePhone(testPhone);
  if (!phone) {
    const err = new Error('Invalid test phone number');
    err.statusCode = 400;
    throw err;
  }

  const connection = await PlatformConnection.findOne({
    _id: campaign.connection,
    organization: orgId,
    platform: 'whatsapp'
  }).select('accessToken platformData platformUserId').lean();

  if (!connection) {
    const err = new Error('WhatsApp connection not found');
    err.statusCode = 400;
    throw err;
  }

  // Build params for the synthetic test recipient.  Prefer explicit testParams (from editor),
  // then fall back to the most recent real recipient with templateParams, otherwise use
  // each slot's example value (already wired in the builder).
  let recipientParams = (testParams && typeof testParams === 'object') ? { ...testParams } : null;
  if (!recipientParams) {
    const sample = await WhatsAppCampaignRecipient.findOne({
      campaign: campaignId,
      templateParams: { $exists: true, $ne: null }
    }).select('templateParams').lean();
    recipientParams = sample?.templateParams || {};
  }

  const components = buildRecipientComponents(template, campaign, { templateParams: recipientParams });

  const result = await whatsappService.sendTemplateMessage(
    connection,
    phone,
    template.name,
    template.language || 'en',
    components
  );

  logger.info('[Campaign] Test message sent', { campaignId, testPhone: phone });
  return result;
}

module.exports = {
  createCampaign,
  listCampaigns,
  getCampaign,
  updateCampaign,
  deleteCampaign,
  addRecipients,
  addRecipientsWithMapping,
  previewRecipientCsv,
  getTemplateSlotsForCampaign,
  getRecipients,
  getRecipientsReport,
  clearRecipients,
  launchCampaign,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  getCampaignStats,
  sendTestMessage,
  applyRecipientDeliveryStatus,
  markRecipientReplied,
  computeRecipientReportStatus
};
