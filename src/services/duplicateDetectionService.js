'use strict';

const Contact = require('../models/Contact');
const DuplicateCandidate = require('../models/DuplicateCandidate');
const Organization = require('../models/Organization');

const BULK_CHUNK = 500;

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function nameScore(a, b) {
  const na = String(a || '').trim().toLowerCase();
  const nb = String(b || '').trim().toLowerCase();
  if (!na || !nb || na === 'unknown' || nb === 'unknown') return 0;
  if (na === nb) return 40;
  if (na.includes(nb) || nb.includes(na)) return 25;
  return 0;
}

function segmentTag(segmentId) {
  return `seg:${String(segmentId).slice(-12)}`;
}

async function flushCandidateOps(orgId, operations) {
  if (!operations.length) return 0;
  for (let i = 0; i < operations.length; i += BULK_CHUNK) {
    await DuplicateCandidate.bulkWrite(operations.slice(i, i + BULK_CHUNK), { ordered: false });
  }
  return operations.length;
}

function buildCandidateOps(orgId, candidates) {
  return [...candidates.values()].map((candidate) => {
    const matchedOn = [...candidate.matchedOn];
    const exactScore = matchedOn.length > 1 ? 90 : 70;
    const score = Math.min(
      100,
      exactScore + nameScore(candidate.contactA.primaryName, candidate.contactB.primaryName)
    );
    return {
      updateOne: {
        filter: {
          organization: orgId,
          contactA: candidate.contactA._id,
          contactB: candidate.contactB._id
        },
        update: {
          $setOnInsert: {
            organization: orgId,
            contactA: candidate.contactA._id,
            contactB: candidate.contactB._id,
            detectedAt: new Date()
          },
          $set: { matchScore: score, matchedOn, status: 'pending' }
        },
        upsert: true
      }
    };
  });
}

function addCluster(list, reason, candidates) {
  if (list.length < 2) return;
  const canonical = list[0];
  for (let i = 1; i < list.length; i += 1) {
    const other = list[i];
    const [contactA, contactB] = String(canonical._id) < String(other._id)
      ? [canonical, other]
      : [other, canonical];
    const key = `${contactA._id}:${contactB._id}`;
    const current = candidates.get(key) || {
      contactA,
      contactB,
      matchedOn: new Set()
    };
    current.matchedOn.add(reason);
    candidates.set(key, current);
  }
}

/**
 * Stream contacts — never loads the full org into RAM.
 */
async function scanOrganization(orgId) {
  const byPhone = new Map();
  const byEmail = new Map();
  const candidates = new Map();
  let scanned = 0;
  let flushed = 0;

  const cursor = Contact.find({ organization: orgId, isDeleted: false })
    .select('primaryName primaryPhone primaryEmail')
    .lean()
    .cursor();

  for await (const contact of cursor) {
    scanned += 1;
    const minimal = { _id: contact._id, primaryName: contact.primaryName };

    const phone = normalizePhone(contact.primaryPhone);
    if (phone.length >= 8) {
      if (!byPhone.has(phone)) byPhone.set(phone, []);
      byPhone.get(phone).push(minimal);
      if (byPhone.get(phone).length === 2) {
        addCluster(byPhone.get(phone), 'phone', candidates);
      } else if (byPhone.get(phone).length > 2) {
        addCluster([byPhone.get(phone)[0], minimal], 'phone', candidates);
      }
    }

    if (contact.primaryEmail) {
      const email = contact.primaryEmail.toLowerCase();
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push(minimal);
      if (byEmail.get(email).length === 2) {
        addCluster(byEmail.get(email), 'email', candidates);
      } else if (byEmail.get(email).length > 2) {
        addCluster([byEmail.get(email)[0], minimal], 'email', candidates);
      }
    }

    if (candidates.size >= BULK_CHUNK) {
      flushed += await flushCandidateOps(orgId, buildCandidateOps(orgId, candidates));
      candidates.clear();
    }
  }

  flushed += await flushCandidateOps(orgId, buildCandidateOps(orgId, candidates));
  return { scanned, candidates: flushed };
}

async function scanAllOrganizations() {
  let orgs = 0;
  let enqueued = 0;
  const { duplicateScanQueue } = require('../config/queue');
  const cursor = Organization.find({ isActive: { $ne: false } }).select('_id').lean().cursor();
  for await (const org of cursor) {
    orgs += 1;
    await duplicateScanQueue.add(
      { organizationId: String(org._id) },
      { jobId: `duplicate-scan:${org._id}:nightly`, removeOnComplete: 5 }
    );
    enqueued += 1;
  }
  return { orgs, enqueued };
}

async function listPending(orgId, { page = 1, limit = 20 } = {}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const q = { organization: orgId, status: 'pending' };
  const [items, total] = await Promise.all([
    DuplicateCandidate.find(q)
      .populate('contactA', 'primaryName primaryPhone primaryEmail channels lifecycleStage')
      .populate('contactB', 'primaryName primaryPhone primaryEmail channels lifecycleStage')
      .sort({ matchScore: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    DuplicateCandidate.countDocuments(q)
  ]);
  return { items, pagination: { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) } };
}

async function dismiss(orgId, id, userId) {
  return DuplicateCandidate.findOneAndUpdate(
    { _id: id, organization: orgId },
    { $set: { status: 'dismissed', reviewedBy: userId || null } },
    { new: true }
  ).lean();
}

module.exports = {
  scanOrganization,
  scanAllOrganizations,
  listPending,
  dismiss,
  segmentTag
};
