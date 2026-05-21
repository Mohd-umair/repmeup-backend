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

  const allowed = ['name', 'templateRef', 'scheduledAt', 'connection'];
  for (const key of allowed) {
    if (updates[key] === undefined) continue;
    if (key === 'templateRef') {
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
    campaign[key] = updates[key];
  }

  await campaign.save();
  return campaign;
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

async function launchCampaign({ orgId, campaignId, templateComponents }) {
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

  const total = await WhatsAppCampaignRecipient.countDocuments({ campaign: campaignId });
  if (total === 0) {
    const err = new Error('No recipients added. Please add at least one phone number.');
    err.statusCode = 400;
    throw err;
  }

  // Store template snapshot
  campaign.templateSnapshot = {
    name: template.name,
    languageCode: template.language,
    components: templateComponents || []
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

async function sendTestMessage({ orgId, campaignId, testPhone, templateComponents }) {
  const campaign = await WhatsAppCampaign.findOne({ _id: campaignId, organization: orgId })
    .populate('templateRef', 'name language status')
    .lean();
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
  if (campaign.templateRef.status !== 'APPROVED') {
    const err = new Error('Template is not approved by Meta');
    err.statusCode = 400;
    throw err;
  }

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

  const result = await whatsappService.sendTemplateMessage(
    connection,
    phone,
    campaign.templateRef.name,
    campaign.templateRef.language || 'en',
    templateComponents || []
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
