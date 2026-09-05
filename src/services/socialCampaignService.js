'use strict';

const Campaign = require('../models/Campaign');
const AudienceMember = require('../models/AudienceMember');
const SocialCampaignRecipient = require('../models/SocialCampaignRecipient');
const PlatformConnection = require('../models/PlatformConnection');
const instagramService = require('../integrations/meta/instagramService');
const facebookService = require('../integrations/meta/facebookService');
const { record } = require('./contactActivityService');
const { evaluateContact } = require('./channelEligibilityService');
const Contact = require('../models/Contact');
const { sessionMap } = require('./channelEligibilityService');

function personalize(template, contact) {
  const first = (contact.primaryName || '').split(' ')[0] || 'there';
  return String(template || '')
    .replace(/\{\{\s*first_name\s*\}\}/gi, first)
    .replace(/\{\{\s*last_name\s*\}\}/gi, (contact.primaryName || '').split(' ').slice(1).join(' '))
    .replace(/\{\{\s*company\s*\}\}/gi, contact.company || '')
    .replace(/\{\{\s*city\s*\}\}/gi, contact.shipping?.city || '');
}

async function seedRecipients(campaign) {
  const cursor = AudienceMember.find({
    organization: campaign.organization,
    audienceSnapshot: campaign.audienceSnapshot,
    channel: campaign.channel,
    eligible: true
  }).select('contact platformUserId').lean().cursor();
  let count = 0;
  let operations = [];
  for await (const member of cursor) {
    operations.push({
      updateOne: {
        filter: { campaign: campaign._id, contact: member.contact },
        update: {
          $setOnInsert: {
            organization: campaign.organization,
            campaign: campaign._id,
            contact: member.contact,
            platformUserId: member.platformUserId,
            status: 'pending'
          }
        },
        upsert: true
      }
    });
    count += 1;
    if (operations.length >= 500) {
      await SocialCampaignRecipient.bulkWrite(operations, { ordered: false });
      operations = [];
    }
  }
  if (operations.length) await SocialCampaignRecipient.bulkWrite(operations, { ordered: false });
  return count;
}

async function sendBatch({ orgId, campaignId, limit = 40 }) {
  const campaign = await Campaign.findOne({ _id: campaignId, organization: orgId });
  if (!campaign || !['running', 'queued'].includes(campaign.status)) return { sent: 0 };

  const connection = await PlatformConnection.findOne({
    _id: campaign.connection,
    organization: orgId,
    platform: campaign.channel,
    isActive: true
  }).lean();
  if (!connection) {
    campaign.status = 'failed';
    await campaign.save();
    return { sent: 0, error: 'Connection missing' };
  }

  const pending = [];
  for (let i = 0; i < Math.min(100, Math.max(1, limit)); i += 1) {
    // Atomic claim prevents overlapping Bull workers/manual ticks from sending
    // the same recipient concurrently.
    const claimed = await SocialCampaignRecipient.findOneAndUpdate(
      { organization: orgId, campaign: campaignId, status: 'pending' },
      { $set: { status: 'processing', claimedAt: new Date() } },
      { new: true }
    ).lean();
    if (!claimed) break;
    pending.push(claimed);
  }
  if (!pending.length) {
    const processing = await SocialCampaignRecipient.exists({
      organization: orgId,
      campaign: campaignId,
      status: 'processing'
    });
    if (processing) return { sent: 0, waiting: true };
    campaign.status = 'completed';
    campaign.finishedAt = new Date();
    await campaign.save();
    return { sent: 0, done: true };
  }

  const contactIds = pending.map((p) => p.contact);
  const inSession = await sessionMap(orgId, contactIds, campaign.channel);
  const contacts = await Contact.find({
    _id: { $in: contactIds },
    organization: orgId,
    isDeleted: false
  }).select('primaryName company shipping channels communicationPreferences flowsOptedOut').lean();
  const byId = new Map(contacts.map((c) => [String(c._id), c]));

  const token = connection.accessToken || connection.platformData?.accessToken;
  const pageId = connection.platformUserId || connection.platformData?.pageId;
  let sent = 0;
  let failed = 0;

  for (const row of pending) {
    const contact = byId.get(String(row.contact));
    const live = evaluateContact(contact || {}, campaign.channel, { inSession: inSession.has(String(row.contact)) });
    if (!live.eligible) {
      await SocialCampaignRecipient.updateOne(
        { _id: row._id, organization: orgId, status: 'processing' },
        { $set: { status: 'skipped', errorMessage: live.reason } }
      );
      failed += 1;
      continue;
    }
    const text = personalize(campaign.content?.body, contact || {});
    try {
      let result;
      if (campaign.channel === 'instagram') {
        result = await instagramService.sendMessage(row.platformUserId, text, token, pageId, true, connection.connectionType);
      } else {
        result = await facebookService.sendMessage(row.platformUserId, text, token, pageId, true);
      }
      await SocialCampaignRecipient.updateOne(
        { _id: row._id, organization: orgId, status: 'processing' },
        { $set: { status: 'sent', sentAt: new Date(), messageId: result?.message_id || result?.id || null } }
      );
      await record({
        organization: orgId,
        contact: row.contact,
        type: 'campaign_sent',
        channel: campaign.channel,
        relatedCampaign: campaign._id,
        payload: { campaignName: campaign.name }
      });
      sent += 1;
    } catch (err) {
      await SocialCampaignRecipient.updateOne(
        { _id: row._id, organization: orgId, status: 'processing' },
        { $set: { status: 'failed', errorMessage: err.message } }
      );
      await record({
        organization: orgId,
        contact: row.contact,
        type: 'campaign_failed',
        channel: campaign.channel,
        relatedCampaign: campaign._id,
        payload: { error: err.message }
      });
      failed += 1;
    }
  }

  await Campaign.updateOne(
    { _id: campaignId, organization: orgId },
    {
      $inc: {
        'stats.sent': sent,
        'stats.failed': failed,
        'stats.pending': -pending.length
      }
    }
  );
  return { sent, failed };
}

async function launchSocial({ orgId, campaign }) {
  const count = await seedRecipients(campaign);
  campaign.status = 'running';
  campaign.startedAt = new Date();
  campaign.stats.eligible = count;
  campaign.stats.pending = count;
  await campaign.save();
  return sendBatch({ orgId, campaignId: campaign._id, limit: 40 });
}

module.exports = { launchSocial, sendBatch, personalize, seedRecipients };
