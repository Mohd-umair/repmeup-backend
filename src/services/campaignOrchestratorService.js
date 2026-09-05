'use strict';

const Campaign = require('../models/Campaign');
const AudienceSnapshot = require('../models/AudienceSnapshot');
const AudienceMember = require('../models/AudienceMember');
const Contact = require('../models/Contact');
const PlatformConnection = require('../models/PlatformConnection');
const campaignService = require('./campaignService');
const { launchSocial, sendBatch, personalize } = require('./socialCampaignService');
const { validateCampaign } = require('./campaignValidationService');
const { record } = require('./contactActivityService');
const openaiClient = require('./ai/openaiClient');
const { completionTextFromOpenAIResponse } = require('../utils/openaiModelHelpers');

const CHANNELS = new Set(['whatsapp', 'instagram', 'facebook']);

async function assertConnection(orgId, connectionId, channel) {
  if (!connectionId) return null;
  const connection = await PlatformConnection.findOne({
    _id: connectionId,
    organization: orgId,
    isActive: true
  }).select('_id platform').lean();
  if (!connection) throw Object.assign(new Error('Connected account not found'), { status: 400 });
  if (channel && connection.platform !== channel) {
    throw Object.assign(new Error('Account does not match the selected channel'), { status: 400 });
  }
  return connection._id;
}

async function createDraft({ orgId, userId, name, channel, audienceSnapshotId, connectionId }) {
  if (!CHANNELS.has(channel)) throw Object.assign(new Error('Invalid campaign channel'), { status: 400 });
  connectionId = await assertConnection(orgId, connectionId, channel);
  const snapshot = audienceSnapshotId
    ? await AudienceSnapshot.findOne({ _id: audienceSnapshotId, organization: orgId }).lean()
    : null;
  if (audienceSnapshotId && !snapshot) {
    throw Object.assign(new Error('Audience snapshot not found'), { status: 404 });
  }
  const matched = snapshot?.totalMatched || 0;
  const eligible = snapshot?.channelEligibility?.[channel]?.eligible || 0;

  const campaign = await Campaign.create({
    organization: orgId,
    name: String(name || 'Untitled campaign').trim().slice(0, 160),
    channel,
    status: 'draft',
    audienceSourceType: snapshot?.sourceType || 'filter',
    audienceSourceRef: snapshot?.sourceRef || null,
    audienceSnapshot: snapshot?._id || null,
    connection: connectionId || null,
    stats: { matched, eligible, pending: eligible },
    createdBy: userId || null
  });
  return campaign.toObject();
}

async function updateDraft(orgId, id, updates) {
  const campaign = await Campaign.findOne({ _id: id, organization: orgId, status: 'draft' });
  if (!campaign) throw Object.assign(new Error('Draft campaign not found'), { status: 404 });
  if (updates.channel !== undefined && !CHANNELS.has(updates.channel)) {
    throw Object.assign(new Error('Invalid campaign channel'), { status: 400 });
  }
  if (updates.audienceSnapshot !== undefined) {
    const snapshot = await AudienceSnapshot.findOne({
      _id: updates.audienceSnapshot,
      organization: orgId
    }).lean();
    if (!snapshot) throw Object.assign(new Error('Audience snapshot not found'), { status: 404 });
  }
  if (updates.connection !== undefined) {
    updates.connection = await assertConnection(orgId, updates.connection, updates.channel || campaign.channel);
  }
  if (updates.parentCampaignId !== undefined && updates.parentCampaignId) {
    const parent = await Campaign.exists({ _id: updates.parentCampaignId, organization: orgId });
    if (!parent) throw Object.assign(new Error('Parent campaign not found'), { status: 404 });
  }
  if (updates.content?.body && String(updates.content.body).length > 2000) {
    throw Object.assign(new Error('Campaign message is too long'), { status: 400 });
  }
  const allowed = ['name', 'channel', 'content', 'connection', 'schedule', 'audienceSnapshot', 'followUpCondition', 'parentCampaignId'];
  for (const key of allowed) {
    if (updates[key] !== undefined) campaign[key] = key === 'name'
      ? String(updates[key]).trim().slice(0, 160)
      : updates[key];
  }
  if (updates.channel !== undefined || updates.audienceSnapshot !== undefined) {
    const snapshotId = updates.audienceSnapshot || campaign.audienceSnapshot;
    const snapshot = await AudienceSnapshot.findOne({ _id: snapshotId, organization: orgId }).lean();
    campaign.stats.matched = snapshot?.totalMatched || 0;
    campaign.stats.eligible = snapshot?.channelEligibility?.[campaign.channel]?.eligible || 0;
    campaign.stats.pending = campaign.stats.eligible;
  }
  await campaign.save();
  return campaign.toObject();
}

async function listCampaigns({ orgId, page = 1, limit = 20, status }) {
  const q = { organization: orgId };
  if (status) q.status = status;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const [items, total] = await Promise.all([
    Campaign.find(q).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
    Campaign.countDocuments(q)
  ]);
  return { items, pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) } };
}

async function getCampaign(orgId, id) {
  return Campaign.findOne({ _id: id, organization: orgId }).lean();
}

async function previewPersonalization(orgId, campaignId, offset = 0) {
  const campaign = await Campaign.findOne({ _id: campaignId, organization: orgId }).lean();
  if (!campaign?.audienceSnapshot) return { items: [], index: 0, total: 0 };
  const total = await AudienceMember.countDocuments({
    organization: orgId,
    audienceSnapshot: campaign.audienceSnapshot,
    channel: campaign.channel,
    eligible: true
  });
  const member = await AudienceMember.findOne({
    organization: orgId,
    audienceSnapshot: campaign.audienceSnapshot,
    channel: campaign.channel,
    eligible: true
  })
    .sort({ _id: 1 })
    .skip(Math.min(100, Math.max(0, offset)))
    .populate('contact', 'primaryName primaryPhone company shipping.city')
    .lean();
  if (!member?.contact) return { items: [], index: offset, total };
  const body = campaign.channel === 'whatsapp'
    ? (campaign.content?.previewText || campaign.content?.body || '')
    : personalize(campaign.content?.body, member.contact);
  return {
    index: offset,
    total,
    contact: {
      _id: member.contact._id,
      name: member.contact.primaryName,
      phone: member.contact.primaryPhone
    },
    preview: body
  };
}

async function generateContent({ orgId, goal, tone, language, offer }) {
  const fallback = `Hi {{first_name}},\n\nWe have something for you${offer ? `: ${offer}` : '.'}\n\nReply if you'd like details.`;
  if (!openaiClient.hasApiKey()) return { text: fallback, source: 'fallback' };
  const clip = (value, fallback) => String(value || fallback).slice(0, 200);
  const response = await openaiClient.chatCompletion({
    model: openaiClient.classificationModel,
    max_tokens: 280,
    messages: [
      { role: 'system', content: 'Write a short customer campaign message. Use {{first_name}} once. No secrets. Keep it under 80 words.' },
      { role: 'user', content: `Goal: ${clip(goal, 'Promotion')}\nTone: ${clip(tone, 'Friendly')}\nLanguage: ${clip(language, 'English')}\nOffer: ${clip(offer, '')}` }
    ]
  }, { organizationId: orgId, feature: 'campaign.ai_generate' });
  const text = completionTextFromOpenAIResponse(response.data) || fallback;
  return { text, source: 'ai' };
}

async function launch({ orgId, userId, campaignId, sendNow = true, scheduledJob = false }) {
  let campaign = await Campaign.findOne({ _id: campaignId, organization: orgId });
  if (!campaign) throw Object.assign(new Error('Campaign not found'), { status: 404 });
  const validation = await validateCampaign(orgId, campaignId);
  if (!validation.ok) {
    const err = new Error('Campaign is not ready to send');
    err.status = 400;
    err.details = validation;
    throw err;
  }

  if (!sendNow) {
    const sendAt = campaign.schedule?.sendAt ? new Date(campaign.schedule.sendAt) : null;
    if (!sendAt || Number.isNaN(sendAt.getTime()) || sendAt <= new Date()) {
      throw Object.assign(new Error('A future schedule date is required'), { status: 400 });
    }
    const scheduled = await Campaign.findOneAndUpdate(
      { _id: campaignId, organization: orgId, status: 'draft' },
      { $set: { status: 'scheduled' } },
      { new: true }
    );
    if (!scheduled) throw Object.assign(new Error('Campaign has already been launched'), { status: 409 });
    const { activationCampaignLaunchQueue } = require('../config/queue');
    try {
      await activationCampaignLaunchQueue.add(
        { campaignId: String(campaignId), organizationId: String(orgId), userId: userId ? String(userId) : null },
        {
          delay: Math.max(0, sendAt.getTime() - Date.now()),
          jobId: `activation-launch:${campaignId}`,
          attempts: 3,
          removeOnComplete: 20
        }
      );
    } catch (error) {
      await Campaign.updateOne(
        { _id: campaignId, organization: orgId, status: 'scheduled' },
        { $set: { status: 'draft' } }
      );
      throw error;
    }
    return scheduled.toObject();
  }

  const allowedStatuses = scheduledJob ? ['scheduled'] : ['draft', 'scheduled'];
  campaign = await Campaign.findOneAndUpdate(
    { _id: campaignId, organization: orgId, status: { $in: allowedStatuses } },
    { $set: { status: 'queued' } },
    { new: true }
  );
  if (!campaign) throw Object.assign(new Error('Campaign has already been launched'), { status: 409 });

  try {
    if (campaign.channel === 'whatsapp') {
    const wa = await campaignService.createCampaign({
      orgId,
      userId,
      name: campaign.name,
      connectionId: campaign.connection,
      templateRefId: campaign.content?.templateId
    });
    const phoneBatch = [];
    const memberCursor = AudienceMember.find({
      organization: orgId,
      audienceSnapshot: campaign.audienceSnapshot,
      channel: 'whatsapp',
      eligible: true
    }).select('contact').lean().cursor();
    async function flushPhones() {
      if (!phoneBatch.length) return;
      const contacts = await Contact.find({
        _id: { $in: phoneBatch.splice(0, phoneBatch.length) },
        organization: orgId,
        isDeleted: false
      }).select('primaryPhone').lean();
      const rawText = contacts.map((contact) => contact.primaryPhone).filter(Boolean).join('\n');
      if (rawText) {
        await campaignService.addRecipients({ orgId, campaignId: wa._id, rawText });
      }
    }
    for await (const member of memberCursor) {
      if (member.contact) phoneBatch.push(member.contact);
      if (phoneBatch.length >= 400) await flushPhones();
    }
    await flushPhones();
    if (campaign.content?.templateId) {
      await campaignService.updateCampaign({
        orgId,
        campaignId: wa._id,
        updates: { templateRef: campaign.content.templateId }
      });
    }
    campaign.whatsAppCampaignRef = wa._id;
    await campaignService.launchCampaign({ orgId, campaignId: wa._id });
    campaign.status = 'running';
    campaign.startedAt = new Date();
    await campaign.save();
      return campaign.toObject();
    }

    await launchSocial({ orgId, campaign });
    const { socialCampaignSendQueue } = require('../config/queue');
    await socialCampaignSendQueue.add(
      { campaignId: String(campaign._id), organizationId: String(orgId) },
      { delay: 2000, jobId: `social-send:${campaign._id}:initial`, removeOnComplete: 20 }
    );
    return Campaign.findOne({ _id: campaign._id, organization: orgId }).lean();
  } catch (error) {
    await Campaign.updateOne(
      { _id: campaignId, organization: orgId, status: { $in: ['queued', 'running'] } },
      { $set: { status: 'failed' } }
    );
    throw error;
  }
}

async function pause(orgId, id) {
  const campaign = await Campaign.findOne({ _id: id, organization: orgId });
  if (!campaign) throw Object.assign(new Error('Campaign not found'), { status: 404 });
  if (!['queued', 'running'].includes(campaign.status)) {
    throw Object.assign(new Error('Only a queued or running campaign can be paused'), { status: 400 });
  }
  campaign.status = 'paused';
  await campaign.save();
  if (campaign.whatsAppCampaignRef) {
    try { await campaignService.pauseCampaign({ orgId, campaignId: campaign.whatsAppCampaignRef }); } catch { /* ignore */ }
  }
  return campaign.toObject();
}

async function resume(orgId, id) {
  const campaign = await Campaign.findOne({ _id: id, organization: orgId });
  if (!campaign) throw Object.assign(new Error('Campaign not found'), { status: 404 });
  if (campaign.status !== 'paused') {
    throw Object.assign(new Error('Only a paused campaign can be resumed'), { status: 400 });
  }
  campaign.status = 'running';
  await campaign.save();
  if (campaign.whatsAppCampaignRef) {
    try { await campaignService.resumeCampaign({ orgId, campaignId: campaign.whatsAppCampaignRef }); } catch { /* ignore */ }
  } else {
    await sendBatch({ orgId, campaignId: id });
    const { socialCampaignSendQueue } = require('../config/queue');
    await socialCampaignSendQueue.add(
      { campaignId: String(id), organizationId: orgId },
      { delay: 2000, removeOnComplete: 20 }
    );
  }
  return campaign.toObject();
}

async function stats(orgId, id) {
  const campaign = await Campaign.findOne({ _id: id, organization: orgId }).lean();
  if (!campaign) return null;
  if (campaign.whatsAppCampaignRef) {
    try {
      const wa = await campaignService.getCampaignStats({ orgId, campaignId: campaign.whatsAppCampaignRef });
      return { ...campaign.stats, ...wa };
    } catch {
      return campaign.stats;
    }
  }
  return campaign.stats;
}

async function createFollowUp({ orgId, userId, parentId, condition = 'did_not_reply' }) {
  const parent = await Campaign.findOne({ _id: parentId, organization: orgId }).lean();
  if (!parent) throw Object.assign(new Error('Parent campaign not found'), { status: 404 });
  const audienceService = require('./audienceService');
  const filterQuery = {
    logic: 'AND',
    conditions: [{ field: 'campaign', operator: 'eq', value: { campaignId: String(parent._id), condition } }]
  };
  const snapshot = await audienceService.createSnapshot({
    orgId,
    userId,
    sourceType: 'filter',
    filterQuery
  });
  const draft = await Campaign.create({
    organization: orgId,
    name: `Follow-up: ${parent.name}`,
    channel: parent.channel,
    status: 'draft',
    audienceSourceType: 'filter',
    audienceSnapshot: snapshot._id,
    parentCampaignId: parent._id,
    followUpCondition: condition,
    connection: parent.connection,
    stats: { matched: snapshot.totalMatched || 0, eligible: snapshot.channelEligibility?.[parent.channel]?.eligible || 0 },
    content: {
      body: 'Hi {{first_name}},\n\nJust checking if you would still like to take this up.\n\nReply and we will help.'
    },
    createdBy: userId || null
  });
  return draft.toObject();
}

module.exports = {
  createDraft,
  updateDraft,
  listCampaigns,
  getCampaign,
  previewPersonalization,
  generateContent,
  launch,
  pause,
  resume,
  stats,
  createFollowUp,
  personalize,
  record
};
