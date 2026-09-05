'use strict';

const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Interaction = require('../models/Interaction');
const ContactNote = require('../models/ContactNote');
const ContactTask = require('../models/ContactTask');
const ContactActivity = require('../models/ContactActivity');
const CommerceOrder = require('../models/CommerceOrder');
const AudienceMember = require('../models/AudienceMember');
const SocialCampaignRecipient = require('../models/SocialCampaignRecipient');
const MergeAuditLog = require('../models/MergeAuditLog');
const DuplicateCandidate = require('../models/DuplicateCandidate');
const { record } = require('./contactActivityService');

function unionTags(a = [], b = []) {
  return [...new Set([...a, ...b].map((t) => String(t).trim()).filter(Boolean))];
}

function mergeChannels(primary, secondary) {
  const seen = new Set(primary.map((c) => `${c.platform}:${c.platformUserId}`));
  const extra = secondary.filter((c) => !seen.has(`${c.platform}:${c.platformUserId}`));
  return [...primary, ...extra];
}

async function mergeContacts({ orgId, userId, primaryId, secondaryId, fieldResolutions = {} }) {
  if (!mongoose.Types.ObjectId.isValid(primaryId) || !mongoose.Types.ObjectId.isValid(secondaryId)) {
    throw Object.assign(new Error('Invalid contact id'), { status: 400 });
  }
  if (String(primaryId) === String(secondaryId)) {
    throw Object.assign(new Error('Cannot merge a contact into itself'), { status: 400 });
  }

  let merged;
  let secondarySnapshot;
  async function execute(session = null) {
    const queryOptions = session ? { session } : {};
    const [primary, secondary] = await Promise.all([
      Contact.findOne({ _id: primaryId, organization: orgId, isDeleted: false }, null, queryOptions),
      Contact.findOne({ _id: secondaryId, organization: orgId, isDeleted: false }, null, queryOptions)
    ]);
    if (!primary || !secondary) {
      throw Object.assign(new Error('Contact not found'), { status: 404 });
    }

    secondarySnapshot = secondary.toObject();
    const pick = (field, fallback) => (fieldResolutions[field] === 'secondary' ? secondary[field] : fallback);
    primary.primaryName = pick('primaryName', primary.primaryName || secondary.primaryName);
    primary.primaryPhone = pick('primaryPhone', primary.primaryPhone || secondary.primaryPhone);
    primary.primaryEmail = pick('primaryEmail', primary.primaryEmail || secondary.primaryEmail);
    primary.company = pick('company', primary.company || secondary.company);
    primary.notes = pick('notes', primary.notes || secondary.notes);
    primary.lifecycleStage = pick('lifecycleStage', primary.lifecycleStage);
    primary.owner = pick('owner', primary.owner || secondary.owner);
    primary.tags = unionTags(primary.tags, secondary.tags);
    primary.channels = mergeChannels(primary.channels || [], secondary.channels || []);
    primary.mergedFrom = [...new Set([
      ...(primary.mergedFrom || []).map(String),
      ...(secondary.mergedFrom || []).map(String),
      String(secondary._id)
    ])];
    primary.customFields = new Map([
      ...Object.entries(secondary.customFields?.toObject?.() || secondary.customFields || {}),
      ...Object.entries(primary.customFields?.toObject?.() || primary.customFields || {})
    ]);
    const primaryPrefs = primary.communicationPreferences || {};
    const secondaryPrefs = secondary.communicationPreferences || {};
    primary.communicationPreferences = {
      whatsapp: primaryPrefs.whatsapp !== false && secondaryPrefs.whatsapp !== false,
      sms: primaryPrefs.sms !== false && secondaryPrefs.sms !== false,
      email: primaryPrefs.email !== false && secondaryPrefs.email !== false,
      instagram: primaryPrefs.instagram !== false && secondaryPrefs.instagram !== false,
      facebook: primaryPrefs.facebook !== false && secondaryPrefs.facebook !== false,
      marketingConsent: primaryPrefs.marketingConsent === true && secondaryPrefs.marketingConsent === true,
      doNotContact: Boolean(primaryPrefs.doNotContact || secondaryPrefs.doNotContact)
    };
    if (!primary.lastInteractionAt || (secondary.lastInteractionAt && secondary.lastInteractionAt > primary.lastInteractionAt)) {
      primary.lastInteractionAt = secondary.lastInteractionAt;
    }
    secondary.isDeleted = true;
    await Promise.all([
      primary.save(queryOptions),
      secondary.save(queryOptions)
    ]);

    const scoped = { organization: orgId, contact: secondary._id };
    await Promise.all([
      Interaction.updateMany(scoped, { $set: { contact: primary._id } }, queryOptions),
      ContactNote.updateMany(scoped, { $set: { contact: primary._id } }, queryOptions),
      ContactTask.updateMany(scoped, { $set: { contact: primary._id } }, queryOptions),
      ContactActivity.updateMany(scoped, { $set: { contact: primary._id } }, queryOptions),
      CommerceOrder.updateMany(scoped, { $set: { contact: primary._id } }, queryOptions)
    ]);

    const memberships = await AudienceMember.find(scoped, null, queryOptions).lean();
    for (const membership of memberships) {
      const duplicate = await AudienceMember.exists({
        organization: orgId,
        audienceSnapshot: membership.audienceSnapshot,
        contact: primary._id,
        channel: membership.channel
      }).session(session);
      if (duplicate) {
        await AudienceMember.deleteOne({ _id: membership._id }, queryOptions);
      } else {
        await AudienceMember.updateOne({ _id: membership._id }, { $set: { contact: primary._id } }, queryOptions);
      }
    }

    const socialRecipients = await SocialCampaignRecipient.find(scoped, null, queryOptions).lean();
    for (const recipient of socialRecipients) {
      const duplicate = await SocialCampaignRecipient.exists({
        organization: orgId,
        campaign: recipient.campaign,
        contact: primary._id
      }).session(session);
      if (duplicate) {
        await SocialCampaignRecipient.deleteOne({ _id: recipient._id }, queryOptions);
      } else {
        await SocialCampaignRecipient.updateOne({ _id: recipient._id }, { $set: { contact: primary._id } }, queryOptions);
      }
    }

    await MergeAuditLog.create([{
      organization: orgId,
      primaryContact: primary._id,
      secondaryContact: secondary._id,
      secondaryContactSnapshot: secondarySnapshot,
      fieldResolutions,
      mergedBy: userId || null
    }], queryOptions);
    await DuplicateCandidate.updateMany(
      {
        organization: orgId,
        status: 'pending',
        $or: [
          { contactA: primary._id }, { contactB: primary._id },
          { contactA: secondary._id }, { contactB: secondary._id }
        ]
      },
      { $set: { status: 'merged', reviewedBy: userId || null } },
      queryOptions
    );
    merged = primary.toObject();
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() => execute(session));
  } catch (error) {
    const unsupported = error?.code === 20 || /Transaction numbers are only allowed/i.test(error?.message || '');
    if (!unsupported) throw error;
    await execute();
  } finally {
    await session.endSession();
  }

  await record({
    organization: orgId,
    contact: primaryId,
    type: 'merge',
    actor: { kind: 'user', ref: userId || null },
    payload: { secondaryId, name: secondarySnapshot.primaryName },
    idempotencyKey: `contact-merge:${secondaryId}`
  });

  const { refreshContactMetrics } = require('./commerceMetricsService');
  await refreshContactMetrics(orgId, primaryId);
  return merged;
}

module.exports = { mergeContacts };
