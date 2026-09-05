const Lead = require('../../models/Lead');
const LeadActivity = require('../../models/LeadActivity');
const User = require('../../models/User');
const { parsePagination, paginationMeta } = require('../../utils/pagination');
const { escapeRegex } = require('../../utils/sanitize');

/** Pipeline order — also the Kanban column order */
const STATUS_ORDER = Lead.LEAD_STATUSES;
const OPEN_STATUSES = STATUS_ORDER.filter((s) => s !== 'won' && s !== 'lost');

const ASSIGNEE_SELECT = 'firstName lastName email';

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function findLeadOrFail(id) {
  const lead = await Lead.findOne({ _id: id, isDeleted: false });
  if (!lead) throw httpError('Lead not found', 404);
  return lead;
}

/** Attach a display-ready overdue flag so the frontend never computes dates */
function withOverdue(leadDoc, now = new Date()) {
  return {
    ...leadDoc,
    isOverdue: !!(leadDoc.nextFollowUpAt && leadDoc.nextFollowUpAt < now)
  };
}

/** Recompute the denormalized earliest open task dueAt on the lead */
async function refreshNextFollowUp(leadId) {
  const next = await LeadActivity.findOne({
    lead: leadId,
    isTask: true,
    completedAt: null,
    dueAt: { $ne: null }
  })
    .sort({ dueAt: 1 })
    .select('dueAt')
    .lean();
  await Lead.updateOne({ _id: leadId }, { nextFollowUpAt: next ? next.dueAt : null });
  return next ? next.dueAt : null;
}

const SORT_FIELDS = ['createdAt', 'lastActivityAt', 'nextFollowUpAt', 'estimatedValue'];

async function listLeads(query = {}) {
  const { page, limit, skip } = parsePagination(query);
  const filter = { isDeleted: false };

  if (query.status) filter.status = query.status;
  if (query.source) filter.source = query.source;
  if (query.priority) filter.priority = query.priority;
  if (query.assignedTo) {
    filter.assignedTo = query.assignedTo === 'unassigned' ? null : query.assignedTo;
  }
  if (query.tag) filter.tags = String(query.tag).toLowerCase();
  if (query.dateFrom || query.dateTo) {
    filter.createdAt = {};
    if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
    if (query.dateTo) filter.createdAt.$lte = new Date(query.dateTo);
  }
  if (query.overdueOnly === 'true') {
    filter.nextFollowUpAt = { $ne: null, $lt: new Date() };
  }
  if (query.search && String(query.search).trim()) {
    const q = escapeRegex(String(query.search).trim().slice(0, 100));
    filter.$or = [
      { name: { $regex: q, $options: 'i' } },
      { email: { $regex: q, $options: 'i' } },
      { phone: { $regex: q, $options: 'i' } },
      { company: { $regex: q, $options: 'i' } }
    ];
  }

  const sortBy = SORT_FIELDS.includes(query.sortBy) ? query.sortBy : 'createdAt';
  const sortDir = query.sortDir === 'asc' ? 1 : -1;

  const [items, total] = await Promise.all([
    Lead.find(filter)
      .sort({ [sortBy]: sortDir })
      .skip(skip)
      .limit(limit)
      .select('-captures -meta')
      .populate('assignedTo', ASSIGNEE_SELECT)
      .lean(),
    Lead.countDocuments(filter)
  ]);

  const now = new Date();
  return {
    items: items.map((l) => withOverdue(l, now)),
    pagination: paginationMeta(total, page, limit)
  };
}

async function getLead(id) {
  const lead = await Lead.findOne({ _id: id, isDeleted: false })
    .populate('assignedTo', ASSIGNEE_SELECT)
    .populate('createdBy', ASSIGNEE_SELECT)
    .populate('convertedToOrganization', 'name')
    .lean();
  if (!lead) throw httpError('Lead not found', 404);

  const openTasks = await LeadActivity.find({
    lead: id,
    isTask: true,
    completedAt: null
  })
    .sort({ dueAt: 1 })
    .select('body dueAt createdAt createdBy')
    .populate('createdBy', ASSIGNEE_SELECT)
    .lean();

  const now = new Date();
  return {
    ...withOverdue(lead, now),
    openTasks: openTasks.map((t) => ({
      ...t,
      isOverdue: !!(t.dueAt && t.dueAt < now)
    }))
  };
}

async function logActivity(leadId, fields) {
  return LeadActivity.create({ lead: leadId, ...fields });
}

async function createLead(payload, actor) {
  const lead = await Lead.create({
    name: payload.name,
    email: (payload.email || '').toLowerCase(),
    phone: payload.phone || '',
    company: payload.company || '',
    source: 'manual',
    priority: payload.priority || 'medium',
    estimatedValue: payload.estimatedValue || 0,
    tags: payload.tags || [],
    assignedTo: payload.assignedTo || null,
    createdBy: actor._id,
    captures: [{ kind: 'manual', refId: null, source: 'manual', at: new Date() }]
  });

  await logActivity(lead._id, {
    type: 'system',
    body: 'Lead created manually',
    meta: { initialStatus: lead.status },
    createdBy: actor._id
  });

  return getLead(lead._id);
}

const UPDATABLE_FIELDS = [
  'name',
  'email',
  'phone',
  'company',
  'priority',
  'estimatedValue',
  'tags',
  'lostReason',
  'convertedToOrganization'
];

async function updateLead(id, payload, actor) {
  const lead = await findLeadOrFail(id);
  for (const field of UPDATABLE_FIELDS) {
    if (payload[field] !== undefined) {
      lead[field] = field === 'email' ? String(payload[field]).toLowerCase() : payload[field];
    }
  }
  lead.lastActivityAt = new Date();
  await lead.save();
  return getLead(id);
}

async function changeStatus(id, newStatus, actor, { lostReason } = {}) {
  const lead = await findLeadOrFail(id);
  if (lead.status === newStatus) return getLead(id);

  const now = new Date();
  const from = lead.status;
  const durationMs = Math.max(0, now - lead.stageEnteredAt);

  lead.status = newStatus;
  lead.stageEnteredAt = now;
  lead.lastActivityAt = now;
  if (newStatus === 'lost' && lostReason) lead.lostReason = lostReason;
  await lead.save();

  await logActivity(lead._id, {
    type: 'status_change',
    body: lostReason ? `Marked lost: ${lostReason}` : '',
    meta: { from, to: newStatus, durationMs },
    createdBy: actor._id
  });

  return getLead(id);
}

async function assignLead(id, userId, actor) {
  const lead = await findLeadOrFail(id);

  let target = null;
  if (userId) {
    target = await User.findOne({ _id: userId, role: 'super_admin', isActive: true })
      .select(ASSIGNEE_SELECT)
      .lean();
    if (!target) throw httpError('Assignee must be an active super admin user', 400);
  }

  const fromUserId = lead.assignedTo;
  lead.assignedTo = userId || null;
  lead.lastActivityAt = new Date();
  await lead.save();

  await logActivity(lead._id, {
    type: 'assignment',
    body: target
      ? `Assigned to ${target.firstName} ${target.lastName}`.trim()
      : 'Unassigned',
    meta: { fromUserId, toUserId: userId || null },
    createdBy: actor._id
  });

  return getLead(id);
}

async function softDeleteLead(id) {
  const lead = await findLeadOrFail(id);
  lead.isDeleted = true;
  lead.deletedAt = new Date();
  await lead.save();
  return { deleted: true };
}

const BOARD_CARD_SELECT = 'name company email phone status source priority estimatedValue assignedTo nextFollowUpAt lastActivityAt createdAt';

async function getBoard(query = {}) {
  const filter = { isDeleted: false };
  if (query.source) filter.source = query.source;
  if (query.priority) filter.priority = query.priority;
  if (query.assignedTo) {
    filter.assignedTo = query.assignedTo === 'unassigned' ? null : query.assignedTo;
  }
  if (query.search && String(query.search).trim()) {
    const q = escapeRegex(String(query.search).trim().slice(0, 100));
    filter.$or = [
      { name: { $regex: q, $options: 'i' } },
      { email: { $regex: q, $options: 'i' } },
      { company: { $regex: q, $options: 'i' } }
    ];
  }

  const leads = await Lead.find(filter)
    .sort({ lastActivityAt: -1 })
    .limit(500)
    .select(BOARD_CARD_SELECT)
    .populate('assignedTo', ASSIGNEE_SELECT)
    .lean();

  const board = {};
  for (const status of STATUS_ORDER) board[status] = [];
  const now = new Date();
  for (const lead of leads) {
    if (board[lead.status]) board[lead.status].push(withOverdue(lead, now));
  }
  return { ...board, total: leads.length };
}

async function listActivities(leadId, query = {}) {
  await findLeadOrFail(leadId);
  const { page, limit, skip } = parsePagination(query);
  const filter = { lead: leadId };
  if (query.type) filter.type = query.type;

  const [items, total] = await Promise.all([
    LeadActivity.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('createdBy', ASSIGNEE_SELECT)
      .populate('completedBy', ASSIGNEE_SELECT)
      .lean(),
    LeadActivity.countDocuments(filter)
  ]);

  return { items, pagination: paginationMeta(total, page, limit) };
}

async function addActivity(leadId, { type, body, isTask, dueAt }, actor) {
  const lead = await findLeadOrFail(leadId);

  const activity = await logActivity(lead._id, {
    type: isTask ? 'task' : type,
    body: body || '',
    isTask: !!isTask,
    dueAt: isTask ? new Date(dueAt) : null,
    createdBy: actor._id
  });

  lead.lastActivityAt = new Date();
  await lead.save();
  if (isTask) await refreshNextFollowUp(lead._id);

  return LeadActivity.findById(activity._id)
    .populate('createdBy', ASSIGNEE_SELECT)
    .lean();
}

async function completeTask(leadId, activityId, actor) {
  await findLeadOrFail(leadId);
  const task = await LeadActivity.findOne({
    _id: activityId,
    lead: leadId,
    isTask: true
  });
  if (!task) throw httpError('Task not found', 404);
  if (task.completedAt) throw httpError('Task is already completed', 400);

  task.completedAt = new Date();
  task.completedBy = actor._id;
  await task.save();
  await refreshNextFollowUp(leadId);

  return LeadActivity.findById(task._id)
    .populate('createdBy', ASSIGNEE_SELECT)
    .populate('completedBy', ASSIGNEE_SELECT)
    .lean();
}

async function listFollowUps(query = {}) {
  const { page, limit, skip } = parsePagination(query);
  const now = new Date();
  const filter = { isTask: true, completedAt: null };

  const window = query.window || 'overdue';
  if (window === 'overdue') {
    filter.dueAt = { $lt: now };
  } else if (window === 'today') {
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    filter.dueAt = { $gte: now, $lte: endOfDay };
  } else if (window === 'week') {
    const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    filter.dueAt = { $gte: now, $lte: weekAhead };
  }

  const [items, total] = await Promise.all([
    LeadActivity.find(filter)
      .sort({ dueAt: 1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: 'lead',
        select: 'name company status isDeleted',
        match: { isDeleted: false }
      })
      .populate('createdBy', ASSIGNEE_SELECT)
      .lean(),
    LeadActivity.countDocuments(filter)
  ]);

  return {
    // Tasks whose lead was soft-deleted populate as null — drop them
    items: items
      .filter((t) => t.lead)
      .map((t) => ({ ...t, isOverdue: !!(t.dueAt && t.dueAt < now) })),
    pagination: paginationMeta(total, page, limit)
  };
}

async function getMeta() {
  const assignees = await User.find({ role: 'super_admin', isActive: true })
    .select(ASSIGNEE_SELECT)
    .sort({ firstName: 1 })
    .lean();

  return {
    statuses: Lead.LEAD_STATUSES,
    sources: Lead.LEAD_SOURCES,
    priorities: Lead.LEAD_PRIORITIES,
    activityTypes: LeadActivity.USER_ACTIVITY_TYPES,
    assignees
  };
}

module.exports = {
  STATUS_ORDER,
  OPEN_STATUSES,
  listLeads,
  getLead,
  createLead,
  updateLead,
  changeStatus,
  assignLead,
  softDeleteLead,
  getBoard,
  listActivities,
  addActivity,
  completeTask,
  listFollowUps,
  getMeta,
  refreshNextFollowUp
};
