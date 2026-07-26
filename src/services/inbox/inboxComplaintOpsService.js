'use strict';

const mongoose = require('mongoose');
const Interaction = require('../../models/Interaction');
const { generateOpsRef } = require('../../utils/opsRefHelper');
const {
  CHANNEL_LABELS,
  COMPLAINT_STATUS_LABELS,
  formatDateLabel,
  formatDurationMinutes,
  customerFromInteraction,
  chatDeepLink
} = require('./inboxOpsFormatters');

function buildComplaintFilter(orgId, query) {
  const filter = {
    organization: orgId,
    'complaint.displayRef': { $exists: true, $ne: null }
  };
  const { status, priority, channel, search, from, to, tab } = query;

  const statusVal = tab && tab !== 'all' ? tab : status;
  if (statusVal) filter['complaint.status'] = statusVal;
  if (priority) filter['complaint.priority'] = priority;
  if (channel) filter.platform = channel;
  if (from || to) {
    filter.platformCreatedAt = {};
    if (from) filter.platformCreatedAt.$gte = new Date(from);
    if (to) filter.platformCreatedAt.$lte = new Date(to);
  }
  if (search) {
    filter.$or = [
      { 'complaint.displayRef': { $regex: search, $options: 'i' } },
      { 'complaint.issueSummary': { $regex: search, $options: 'i' } },
      { content: { $regex: search, $options: 'i' } },
      { 'author.name': { $regex: search, $options: 'i' } }
    ];
  }
  return filter;
}

function acknowledgedLabel(complaint) {
  if (!complaint?.acknowledgedAt) return { label: 'No', tone: 'danger' };
  const raised = complaint.timeline?.[0]?.at || complaint.createdAt;
  const ackAt = complaint.acknowledgedAt;
  let minutes = complaint.slaAckMinutes;
  if (minutes == null && raised && ackAt) {
    minutes = Math.round((new Date(ackAt) - new Date(raised)) / 60000);
  }
  return {
    label: minutes != null ? `Yes · ${formatDurationMinutes(minutes)}` : 'Yes',
    tone: 'success'
  };
}

function mapComplaintRow(doc) {
  const c = doc.complaint || {};
  const customer = customerFromInteraction(doc);
  const ack = acknowledgedLabel({ ...c, timeline: c.timeline });
  const assigned = doc.complaint?.assignedTo;
  const assignedName =
    assigned && typeof assigned === 'object'
      ? `${assigned.firstName || ''} ${assigned.lastName || ''}`.trim() || 'Agent'
      : null;

  return {
    id: doc._id.toString(),
    interactionId: doc._id.toString(),
    displayRef: c.displayRef,
    customerName: customer.name,
    customerHandle: customer.handle,
    channel: doc.platform,
    channelLabel: CHANNEL_LABELS[doc.platform] || doc.platform,
    issueSummary: c.issueSummary || doc.content?.substring(0, 120) || '—',
    priority: c.priority || doc.priority || 'medium',
    status: c.status || 'open',
    statusLabel: COMPLAINT_STATUS_LABELS[c.status] || c.status,
    acknowledgedLabel: ack.label,
    acknowledgedTone: ack.tone,
    assignedToName: assignedName || 'Unassigned',
    createdAt: doc.platformCreatedAt || doc.createdAt,
    createdAtLabel: formatDateLabel(doc.platformCreatedAt || doc.createdAt),
    chatDeepLink: chatDeepLink(doc._id.toString())
  };
}

async function listComplaints(orgId, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 30));
  const skip = (page - 1) * limit;
  const filter = buildComplaintFilter(orgId, query);

  const [rows, total] = await Promise.all([
    Interaction.find(filter)
      .select('platform content author platformCreatedAt createdAt priority complaint assignedTo')
      .sort({ platformCreatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('complaint.assignedTo', 'firstName lastName')
      .populate('complaint.acknowledgedBy', 'firstName lastName')
      .lean(),
    Interaction.countDocuments(filter)
  ]);

  return { rows: rows.map(mapComplaintRow), total, page, limit };
}

async function getComplaintStats(orgId) {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const base = { organization: orgId, 'complaint.displayRef': { $exists: true, $ne: null } };

  const [open, acknowledged, resolvedMonth, highPriorityOpen, resolvedWithTime] = await Promise.all([
    Interaction.countDocuments({ ...base, 'complaint.status': 'open' }),
    Interaction.countDocuments({ ...base, 'complaint.status': 'acknowledged' }),
    Interaction.countDocuments({
      ...base,
      'complaint.status': { $in: ['resolved', 'closed'] },
      'complaint.resolvedAt': { $gte: monthStart }
    }),
    Interaction.countDocuments({
      ...base,
      'complaint.status': { $in: ['open', 'acknowledged', 'in_progress'] },
      'complaint.priority': { $in: ['high', 'urgent'] }
    }),
    Interaction.find({
      ...base,
      'complaint.resolvedAt': { $exists: true },
      'complaint.status': { $in: ['resolved', 'closed'] }
    })
      .select('complaint.timeline complaint.resolvedAt platformCreatedAt createdAt')
      .limit(200)
      .lean()
  ]);

  let totalHours = 0;
  let count = 0;
  for (const doc of resolvedWithTime) {
    const raised = doc.complaint?.timeline?.[0]?.at || doc.platformCreatedAt || doc.createdAt;
    const resolved = doc.complaint?.resolvedAt;
    if (raised && resolved) {
      totalHours += (new Date(resolved) - new Date(raised)) / 3600000;
      count += 1;
    }
  }

  return {
    open,
    acknowledged,
    resolvedThisMonth: resolvedMonth,
    highPriorityOpen,
    avgResolutionHours: count ? +(totalHours / count).toFixed(1) : 0
  };
}

async function getComplaintDetail(orgId, interactionId) {
  const doc = await Interaction.findOne({
    _id: interactionId,
    organization: orgId,
    'complaint.displayRef': { $exists: true, $ne: null }
  })
    .populate('complaint.assignedTo', 'firstName lastName email')
    .populate('complaint.acknowledgedBy', 'firstName lastName')
    .populate('complaint.resolvedBy', 'firstName lastName')
    .populate('complaint.linkedOrderId', 'displayRef totalAmount currency')
    .lean();

  if (!doc) return null;

  const c = doc.complaint;
  const ack = acknowledgedLabel(c);
  const customer = customerFromInteraction(doc);

  const chatSnippet = [{ from: 'customer', text: String(doc.content || '').substring(0, 500) }];
  const teamReply = doc.replies?.find((r) => r.content && !r.isPlatformReply);
  if (teamReply?.content) chatSnippet.push({ from: 'team', text: String(teamReply.content).substring(0, 500) });

  const acknowledgedByName = c.acknowledgedBy
    ? `${c.acknowledgedBy.firstName || ''} ${c.acknowledgedBy.lastName || ''}`.trim()
    : null;

  return {
    ...mapComplaintRow(doc),
    customer,
    priorityBanner:
      c.priority === 'high' || c.priority === 'urgent'
        ? `HIGH PRIORITY${acknowledgedByName ? ` · Acknowledged by ${acknowledgedByName}` : ''}`
        : null,
    resolutionNote: c.resolutionNote || null,
    linkedOrderRef: c.linkedOrderId?.displayRef || null,
    timeline: (c.timeline || []).map((t) => ({
      event: t.event,
      at: t.at,
      atLabel: formatDateLabel(t.at),
      note: t.note
    })),
    chatSnippet,
    actions: {
      canAcknowledge: c.status === 'open',
      canAssign: ['open', 'acknowledged', 'in_progress'].includes(c.status),
      canResolve: ['open', 'acknowledged', 'in_progress'].includes(c.status),
      canClose: c.status === 'resolved'
    },
    chatDeepLink: chatDeepLink(doc._id.toString())
  };
}

async function loadComplaint(orgId, interactionId) {
  return Interaction.findOne({
    _id: interactionId,
    organization: orgId,
    'complaint.displayRef': { $exists: true, $ne: null }
  });
}

async function acknowledgeComplaint(orgId, interactionId, userId, note) {
  const doc = await loadComplaint(orgId, interactionId);
  if (!doc) return { error: 'not_found' };
  if (doc.complaint.status !== 'open') return { error: 'invalid_status' };

  const now = new Date();
  const raised = doc.complaint.timeline?.[0]?.at || doc.platformCreatedAt || doc.createdAt;
  const slaAckMinutes = raised ? Math.round((now - new Date(raised)) / 60000) : null;

  doc.complaint.status = 'acknowledged';
  doc.complaint.acknowledgedAt = now;
  doc.complaint.acknowledgedBy = userId;
  doc.complaint.slaAckMinutes = slaAckMinutes;
  doc.complaint.timeline.push({
    event: 'Acknowledged',
    at: now,
    by: userId,
    note: note || undefined
  });
  await doc.save();
  return { detail: await getComplaintDetail(orgId, interactionId) };
}

async function assignComplaint(orgId, interactionId, assigneeId, userId) {
  const doc = await loadComplaint(orgId, interactionId);
  if (!doc) return { error: 'not_found' };

  const now = new Date();
  doc.complaint.assignedTo = assigneeId;
  if (doc.complaint.status === 'open') doc.complaint.status = 'acknowledged';
  doc.complaint.timeline.push({ event: 'Assigned to agent', at: now, by: userId });
  doc.assignedTo = assigneeId;
  await doc.save();
  return { detail: await getComplaintDetail(orgId, interactionId) };
}

async function resolveComplaint(orgId, interactionId, userId, note) {
  const doc = await loadComplaint(orgId, interactionId);
  if (!doc) return { error: 'not_found' };

  const now = new Date();
  doc.complaint.status = 'resolved';
  doc.complaint.resolvedAt = now;
  doc.complaint.resolvedBy = userId;
  if (note) doc.complaint.resolutionNote = note;
  doc.complaint.timeline.push({
    event: 'Resolved',
    at: now,
    by: userId,
    note: note || undefined
  });
  doc.status = 'resolved';
  await doc.save();
  return { detail: await getComplaintDetail(orgId, interactionId) };
}

async function closeComplaint(orgId, interactionId, userId) {
  const doc = await loadComplaint(orgId, interactionId);
  if (!doc) return { error: 'not_found' };
  if (doc.complaint.status !== 'resolved') return { error: 'invalid_status' };

  const now = new Date();
  doc.complaint.status = 'closed';
  doc.complaint.closedAt = now;
  doc.complaint.closedBy = userId;
  doc.complaint.timeline.push({ event: 'Closed', at: now, by: userId });
  await doc.save();
  return { detail: await getComplaintDetail(orgId, interactionId) };
}

/**
 * Manually raise a complaint on an existing interaction.
 * Mirrors ensureComplaintFromIntent but is triggered by an agent rather than AI.
 * Returns { error } if the interaction has an existing open/in-progress complaint,
 * to prevent silent overwrite of the single embedded subdoc.
 */
async function raiseComplaint(orgId, interactionId, { issueSummary, priority } = {}) {
  if (!mongoose.Types.ObjectId.isValid(interactionId)) {
    return { error: 'invalid_interaction_id' };
  }

  const doc = await Interaction.findOne({ _id: interactionId, organization: orgId });
  if (!doc) return { error: 'not_found' };

  if (doc.complaint?.displayRef && !['resolved', 'closed'].includes(doc.complaint.status)) {
    return { error: 'complaint_already_open', displayRef: doc.complaint.displayRef };
  }

  const { displayRef } = await generateOpsRef(orgId, 'complaint');
  const now = new Date();
  const summary = String(issueSummary || doc.content || '')
    .trim()
    .replace(/\s+/g, ' ')
    .substring(0, 280) || 'Customer complaint';

  const safeP = ['low', 'medium', 'high', 'urgent'].includes(priority) ? priority : 'medium';

  await Interaction.findByIdAndUpdate(interactionId, {
    $set: {
      complaint: {
        displayRef,
        status: 'open',
        issueSummary: summary,
        priority: safeP,
        timeline: [{ event: 'Complaint raised manually', at: now, note: summary }]
      }
    }
  });

  return { detail: await getComplaintDetail(orgId, interactionId) };
}

module.exports = {
  listComplaints,
  getComplaintStats,
  getComplaintDetail,
  acknowledgeComplaint,
  assignComplaint,
  resolveComplaint,
  closeComplaint,
  raiseComplaint,
  buildComplaintFilter,
  acknowledgedLabel,
  mapComplaintRow
};
