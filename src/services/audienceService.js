'use strict';

const Contact = require('../models/Contact');
const AudienceSnapshot = require('../models/AudienceSnapshot');
const AudienceMember = require('../models/AudienceMember');
const ContactFilterPreset = require('../models/ContactFilterPreset');
const { mergeQuery, applyCampaignFilters } = require('./contactQueryService');
const { evaluateMany } = require('./channelEligibilityService');

const CHANNELS = ['whatsapp', 'instagram', 'facebook'];
const SYNC_THRESHOLD = 2000;
const MATERIALIZE_BATCH_SIZE = 500;

async function freezeSnapshotMembers(snapshot, query) {
  const target = AudienceMember.collection.name;
  for (const channel of CHANNELS) {
    await Contact.aggregate([
      { $match: query },
      {
        $project: {
          _id: 0,
          organization: { $literal: snapshot.organization },
          audienceSnapshot: { $literal: snapshot._id },
          contact: '$_id',
          channel: { $literal: channel },
          eligible: { $literal: false },
          exclusionReason: { $literal: 'Eligibility pending' },
          platformUserId: { $literal: null },
          createdAt: '$$NOW'
        }
      },
      {
        $merge: {
          into: target,
          on: ['audienceSnapshot', 'contact', 'channel'],
          whenMatched: 'keepExisting',
          whenNotMatched: 'insert'
        }
      }
    ]).allowDiskUse(true);
  }
}

async function resolveFilterQuery(orgId, { sourceType, sourceRef, filterQuery }) {
  if (sourceType === 'saved_view' || sourceType === 'segment') {
    const preset = await ContactFilterPreset.findOne({ _id: sourceRef, organization: orgId }).lean();
    if (!preset) throw Object.assign(new Error('Saved view or segment not found'), { status: 404 });
    return preset.filterQuery || { logic: 'AND', conditions: [] };
  }
  if (sourceType === 'all') return { logic: 'AND', conditions: [] };
  return filterQuery || { logic: 'AND', conditions: [] };
}

async function createSnapshot({ orgId, userId, sourceType, sourceRef, filterQuery }) {
  const resolved = await resolveFilterQuery(orgId, { sourceType, sourceRef, filterQuery });
  const { query, campaignFilters } = mergeQuery(orgId, resolved);
  await applyCampaignFilters(orgId, query, campaignFilters);
  const totalMatched = await Contact.countDocuments(query);

  const snapshot = await AudienceSnapshot.create({
    organization: orgId,
    sourceType,
    sourceRef: sourceRef || null,
    filterQuery: resolved,
    totalMatched,
    materializationStatus: totalMatched > SYNC_THRESHOLD ? 'pending' : 'ready',
    createdBy: userId || null
  });

  if (totalMatched <= SYNC_THRESHOLD) {
    await materializeSnapshot(snapshot._id);
  } else {
    // Freeze the exact IDs now. Eligibility is computed asynchronously, but
    // later edits to a segment/contact cannot change campaign membership.
    await freezeSnapshotMembers(snapshot, query);
    const { audienceMaterializeQueue } = require('../config/queue');
    await audienceMaterializeQueue.add(
      { snapshotId: snapshot._id },
      { jobId: `audience:${snapshot._id}`, removeOnComplete: 20 }
    );
  }

  return AudienceSnapshot.findById(snapshot._id).lean();
}

async function materializeSnapshot(snapshotId, orgId) {
  const snapshot = await AudienceSnapshot.findOne({
    _id: snapshotId,
    ...(orgId ? { organization: orgId } : {})
  });
  if (!snapshot) return null;
  try {
    const { query, campaignFilters } = mergeQuery(snapshot.organization, snapshot.filterQuery);
    await applyCampaignFilters(snapshot.organization, query, campaignFilters);
    const eligibility = Object.fromEntries(
      CHANNELS.map((channel) => [channel, { eligible: 0, ineligible: 0 }])
    );
    let totalMatched = 0;
    let contacts = [];
    const hasFrozenMembers = await AudienceMember.exists({ audienceSnapshot: snapshot._id });
    const sourceCursor = hasFrozenMembers
      ? AudienceMember.find({ audienceSnapshot: snapshot._id, channel: CHANNELS[0] })
        .select('contact -_id')
        .lean()
        .cursor()
      : Contact.find(query)
        .select('channels communicationPreferences flowsOptedOut')
        .lean()
        .cursor();

    async function writeBatch(batch) {
      if (!batch.length) return;
      const hydrated = hasFrozenMembers
        ? await Contact.find({
          _id: { $in: batch.map((row) => row.contact) },
          organization: snapshot.organization,
          isDeleted: false
        }).select('channels communicationPreferences flowsOptedOut').lean()
        : batch;
      const members = [];
      for (const channel of CHANNELS) {
        const evaluated = await evaluateMany(snapshot.organization, hydrated, channel);
        eligibility[channel].eligible += evaluated.eligible;
        eligibility[channel].ineligible += evaluated.ineligible;
        for (const row of evaluated.results) {
          members.push({
            organization: snapshot.organization,
            audienceSnapshot: snapshot._id,
            contact: row.contactId,
            channel,
            eligible: row.eligible,
            exclusionReason: row.reason,
            platformUserId: row.platformUserId || null
          });
        }
      }
      if (members.length) {
        await AudienceMember.bulkWrite(members.map((member) => ({
          updateOne: {
            filter: {
              audienceSnapshot: member.audienceSnapshot,
              contact: member.contact,
              channel: member.channel
            },
            update: { $set: member },
            upsert: true
          }
        })), { ordered: false });
      }
      totalMatched += hydrated.length;
    }

    for await (const contact of sourceCursor) {
      contacts.push(contact);
      if (contacts.length >= MATERIALIZE_BATCH_SIZE) {
        await writeBatch(contacts);
        contacts = [];
      }
    }
    await writeBatch(contacts);

    snapshot.totalMatched = totalMatched;
    snapshot.channelEligibility = eligibility;
    snapshot.materializationStatus = 'ready';
    await snapshot.save();
    return snapshot.toObject();
  } catch (error) {
    snapshot.materializationStatus = 'failed';
    await snapshot.save().catch(() => undefined);
    throw error;
  }
}

async function getSnapshot(orgId, id) {
  return AudienceSnapshot.findOne({ _id: id, organization: orgId }).lean();
}

async function previewMembers({ orgId, snapshotId, channel, eligibleOnly = true, page = 1, limit = 20 }) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const q = { organization: orgId, audienceSnapshot: snapshotId };
  if (channel) q.channel = channel;
  if (eligibleOnly) q.eligible = true;
  const [items, total] = await Promise.all([
    AudienceMember.find(q)
      .populate('contact', 'primaryName primaryPhone primaryEmail channels lifecycleStage')
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    AudienceMember.countDocuments(q)
  ]);
  return { items, pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) } };
}

module.exports = { createSnapshot, materializeSnapshot, getSnapshot, previewMembers, resolveFilterQuery };
