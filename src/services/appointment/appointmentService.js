'use strict';

/**
 * Appointment operations service — the appointment-world analogue of
 * inboxOrderOpsService. Powers the Appointment Management surface and is the
 * shared booking core used by flows and the AI agent.
 */

const Appointment = require('../../models/Appointment');
const Service = require('../../models/Service');
const Provider = require('../../models/Provider');
const Organization = require('../../models/Organization');
const availabilityService = require('./availabilityService');
const { assignAppointmentDisplayRef } = require('../../utils/opsRefHelper');
const {
  CHANNEL_LABELS,
  formatMoney,
  formatDateLabel,
  formatDurationMinutes,
  customerFromContact,
  chatDeepLink
} = require('../inbox/inboxOpsFormatters');
const logger = require('../../config/logger');

const APPOINTMENT_STATUS_LABELS = {
  requested: 'Requested',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
  rescheduled: 'Rescheduled'
};

const APPOINTMENT_STATUS_TONE = {
  requested: 'warning',
  confirmed: 'info',
  completed: 'success',
  cancelled: 'danger',
  no_show: 'danger',
  rescheduled: 'neutral'
};

const VALID_STATUS_TRANSITIONS = {
  requested: ['confirmed', 'cancelled', 'no_show'],
  confirmed: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: [],
  rescheduled: []
};

/** List tabs → underlying statuses. (Time-window tabs handled separately.) */
const TAB_STATUS = {
  upcoming: ['requested', 'confirmed'],
  completed: ['completed'],
  cancelled: ['cancelled'],
  no_show: ['no_show']
};

const STATUS_TIMESTAMP = {
  confirmed: 'confirmedAt',
  completed: 'completedAt',
  cancelled: 'cancelledAt',
  no_show: 'noShowAt'
};

const ACTIVE_STATUSES = ['requested', 'confirmed'];

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// ── Optional cross-phase hooks (no-op until their phase lands) ────────────────

function emitAppointmentEvent(orgId, event, payload) {
  try {
    const { emitToOrg } = require('../../utils/socketEmitter');
    emitToOrg(orgId, event, payload);
  } catch (_) { /* socket optional */ }
}

async function syncGoogle(action, appointment, provider) {
  if (!provider?.google?.connected) return;
  try {
    const gcal = require('../../integrations/google/googleCalendarService');
    if (typeof gcal[action] === 'function') await gcal[action](appointment, provider);
  } catch (err) {
    logger.warn('[appointment] google sync failed (non-fatal)', { action, error: err.message });
  }
}

function scheduleReminders(appointment) {
  try {
    const reminders = require('./appointmentReminderScheduler');
    if (typeof reminders.schedule === 'function') reminders.schedule(appointment);
  } catch (_) { /* reminders land in Phase 4 */ }
}

// ── Mapping ──────────────────────────────────────────────────────────────────

function customerFromAppointment(appt) {
  const contact = appt.contact;
  const name = appt.customerName || contact?.name || 'Unknown';
  const handle = appt.customerPhone || contact?.phone || contact?.email || appt.instagramUserId || '';
  return customerFromContact(contact, name, handle);
}

function whenLabel(appt) {
  const tz = appt.timezone || 'Asia/Kolkata';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    }).format(new Date(appt.startAt));
  } catch {
    return formatDateLabel(appt.startAt);
  }
}

function mapRow(appt) {
  const customer = customerFromAppointment(appt);
  const interactionId = appt.sourceInteraction?._id?.toString?.() || appt.sourceInteraction?.toString?.() || null;
  const serviceName = appt.serviceSnapshot?.name || appt.service?.name || 'Service';
  return {
    id: appt._id.toString(),
    displayRef: appt.displayRef || appt._id.toString().slice(-8).toUpperCase(),
    customerName: customer.name,
    customerHandle: customer.handle,
    channel: appt.channel,
    channelLabel: CHANNEL_LABELS[appt.channel] || appt.channel,
    serviceName,
    providerName: appt.providerSnapshot?.name || appt.provider?.name || '—',
    durationLabel: formatDurationMinutes(appt.serviceSnapshot?.durationMin),
    priceFormatted: formatMoney(appt.serviceSnapshot?.price, appt.serviceSnapshot?.currency),
    startAt: appt.startAt,
    endAt: appt.endAt,
    whenLabel: whenLabel(appt),
    timezone: appt.timezone,
    status: appt.status,
    statusLabel: APPOINTMENT_STATUS_LABELS[appt.status] || appt.status,
    statusTone: APPOINTMENT_STATUS_TONE[appt.status] || 'neutral',
    createdAt: appt.createdAt,
    sourceInteractionId: interactionId,
    chatDeepLink: chatDeepLink(interactionId)
  };
}

function buildTimeline(appt) {
  const events = [{
    event: `Booked via ${CHANNEL_LABELS[appt.channel] || appt.channel}`,
    at: appt.createdAt, atLabel: formatDateLabel(appt.createdAt), pending: false
  }];
  (appt.statusHistory || []).forEach((h) => {
    const label = APPOINTMENT_STATUS_LABELS[h.status] || h.status;
    events.push({
      event: h.note ? `${label} — ${h.note}` : label,
      at: h.at, atLabel: formatDateLabel(h.at), pending: false
    });
  });
  const next = (VALID_STATUS_TRANSITIONS[appt.status] || []).find((s) => s === 'confirmed' || s === 'completed');
  if (next) events.push({ event: `Next: ${APPOINTMENT_STATUS_LABELS[next]}`, at: null, atLabel: 'Pending', pending: true });
  return events;
}

// ── Filters ──────────────────────────────────────────────────────────────────

function buildListFilter(orgId, query) {
  const filter = { organization: orgId };
  const { status, channel, provider, search, from, to, tab } = query;

  if (tab && tab !== 'all' && TAB_STATUS[tab]) filter.status = { $in: TAB_STATUS[tab] };
  else if (status) filter.status = status;

  if (channel) filter.channel = channel;
  if (provider) filter.provider = provider;

  if (from || to) {
    filter.startAt = {};
    if (from) filter.startAt.$gte = new Date(from);
    if (to) filter.startAt.$lte = new Date(to);
  }
  if (search) {
    filter.$or = [
      { displayRef: { $regex: search, $options: 'i' } },
      { customerName: { $regex: search, $options: 'i' } },
      { customerPhone: { $regex: search, $options: 'i' } },
      { 'serviceSnapshot.name': { $regex: search, $options: 'i' } }
    ];
  }
  return filter;
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function listAppointments(orgId, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 30));
  const skip = (page - 1) * limit;
  const filter = buildListFilter(orgId, query);

  // Upcoming default sort = soonest first; otherwise newest booking first.
  const sort = (query.tab === 'upcoming' || query.upcoming) ? { startAt: 1 } : { startAt: -1 };

  const [rows, total] = await Promise.all([
    Appointment.find(filter)
      .select('-__v')
      .sort(sort).skip(skip).limit(limit)
      .populate('contact', 'name phone email avatarUrl')
      .populate('service', 'name')
      .populate('provider', 'name')
      .populate('sourceInteraction', '_id')
      .lean(),
    Appointment.countDocuments(filter)
  ]);

  return { rows: rows.map(mapRow), total, page, limit };
}

async function getStats(orgId) {
  const todayStart = startOfToday();
  const todayEnd = new Date(todayStart.getTime() + 86400000);

  const [facet] = await Appointment.aggregate([
    { $match: { organization: orgId } },
    {
      $facet: {
        total: [{ $count: 'n' }],
        upcoming: [{ $match: { status: { $in: ACTIVE_STATUSES }, startAt: { $gte: new Date() } } }, { $count: 'n' }],
        today: [{ $match: { startAt: { $gte: todayStart, $lt: todayEnd } } }, { $count: 'n' }],
        completed: [{ $match: { status: 'completed' } }, { $count: 'n' }],
        noShow: [{ $match: { status: 'no_show' } }, { $count: 'n' }],
        byStatus: [{ $group: { _id: '$status', n: { $sum: 1 } } }]
      }
    }
  ]);
  const pick = (a) => a?.[0]?.n ?? 0;
  const byStatus = {};
  (facet.byStatus || []).forEach((r) => { byStatus[r._id] = r.n; });
  const statusCounts = { all: pick(facet.total) };
  for (const [tab, statuses] of Object.entries(TAB_STATUS)) {
    statusCounts[tab] = statuses.reduce((s, st) => s + (byStatus[st] || 0), 0);
  }
  return {
    totalAppointments: pick(facet.total),
    upcoming: pick(facet.upcoming),
    today: pick(facet.today),
    completed: pick(facet.completed),
    noShow: pick(facet.noShow),
    statusCounts
  };
}

async function getDetail(orgId, id) {
  const appt = await Appointment.findOne({ _id: id, organization: orgId })
    .populate('contact', 'name phone email avatarUrl tags')
    .populate('service', 'name durationMin price currency')
    .populate('provider', 'name title avatarUrl')
    .populate('sourceInteraction', 'platform type content author replies')
    .lean();
  if (!appt) return null;

  return {
    ...mapRow(appt),
    serviceId: appt.service?._id?.toString?.() || appt.service?.toString?.() || null,
    providerId: appt.provider?._id?.toString?.() || appt.provider?.toString?.() || null,
    customer: customerFromAppointment(appt),
    service: appt.serviceSnapshot || (appt.service ? { name: appt.service.name } : null),
    provider: appt.providerSnapshot || (appt.provider ? { name: appt.provider.name } : null),
    notes: appt.notes || null,
    payment: appt.payment?.required
      ? { required: true, amount: formatMoney(appt.payment.amount, appt.payment.currency), method: appt.payment.method || null, paid: !!appt.payment.paidAt }
      : null,
    cancellationReason: appt.cancellationReason || null,
    reminders: (appt.reminders || []).map((r) => ({ offsetMin: r.offsetMin, sentAt: r.sentAt, channel: r.channel })),
    timeline: buildTimeline(appt),
    actions: {
      canUpdateStatus: (VALID_STATUS_TRANSITIONS[appt.status] || []).length > 0,
      nextStatuses: VALID_STATUS_TRANSITIONS[appt.status] || [],
      canReschedule: ACTIVE_STATUSES.includes(appt.status)
    }
  };
}

async function getByInteraction(orgId, interactionId) {
  if (!/^[a-f\d]{24}$/i.test(String(interactionId || ''))) return null;
  const appt = await Appointment.findOne({ organization: orgId, sourceInteraction: interactionId })
    .sort({ createdAt: -1 })
    .select('_id displayRef status startAt timezone serviceSnapshot.name')
    .lean();
  if (!appt) return null;
  return {
    id: appt._id.toString(),
    displayRef: appt.displayRef || null,
    status: appt.status,
    whenLabel: whenLabel(appt),
    serviceName: appt.serviceSnapshot?.name || null
  };
}

// ── Booking ──────────────────────────────────────────────────────────────────

/**
 * Create an appointment. Snapshots service/provider, re-checks the slot is free
 * (the unique partial index is the final atomic guard), then schedules reminders
 * and syncs Google. Used by manual UI, flows, and the AI agent.
 */
async function createAppointment(orgId, body = {}) {
  const {
    channel = 'manual', serviceId, providerId, startAt,
    customerName, customerPhone, contact, instagramUserId,
    sourceInteraction, sourcePostId, notes, status
  } = body;

  if (!serviceId || !providerId || !startAt) {
    return { error: 'serviceId, providerId and startAt are required' };
  }

  const [service, provider, org] = await Promise.all([
    Service.findOne({ _id: serviceId, organization: orgId, isActive: true }).lean(),
    Provider.findOne({ _id: providerId, organization: orgId, isActive: true }).lean(),
    Organization.findById(orgId).select('appointmentSettings').lean()
  ]);
  if (!service) return { error: 'service_not_found' };
  if (!provider) return { error: 'provider_not_found' };

  const tz = provider.timezone || org?.appointmentSettings?.defaultTimezone || 'Asia/Kolkata';
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) return { error: 'invalid_start_time' };
  const end = new Date(start.getTime() + (service.durationMin || 30) * 60000);

  const free = await availabilityService.isSlotFree({
    orgId, providerId, startAt: start, endAt: end, service
  });
  if (!free) return { error: 'slot_taken' };

  const initialStatus = ['requested', 'confirmed'].includes(status) ? status : 'requested';
  const payload = await assignAppointmentDisplayRef(orgId, {
    organization: orgId,
    channel,
    status: initialStatus,
    service: service._id,
    serviceSnapshot: { name: service.name, durationMin: service.durationMin, price: service.price, currency: service.currency },
    provider: provider._id,
    providerSnapshot: { name: provider.name },
    startAt: start,
    endAt: end,
    timezone: tz,
    contact: contact || undefined,
    customerName: customerName || undefined,
    customerPhone: customerPhone || undefined,
    instagramUserId: instagramUserId || undefined,
    sourceInteraction: sourceInteraction || undefined,
    sourcePostId: sourcePostId || undefined,
    notes: notes || undefined,
    payment: org?.appointmentSettings?.deposit?.required
      ? { required: true, amount: org.appointmentSettings.deposit.amount, currency: service.currency }
      : undefined,
    statusHistory: [{ status: initialStatus, at: new Date(), note: 'Appointment booked' }]
  });

  let appt;
  try {
    appt = await Appointment.create(payload);
  } catch (err) {
    // Lost the race against the unique partial index → slot just got taken.
    if (err.code === 11000) return { error: 'slot_taken' };
    throw err;
  }

  scheduleReminders(appt);
  await syncGoogle('pushEvent', appt, provider);
  emitAppointmentEvent(orgId, 'appointment_booked', {
    appointment: appt.toObject(),
    interactionId: sourceInteraction ? String(sourceInteraction) : undefined
  });

  return { appointment: await getDetail(orgId, appt._id) };
}

async function updateStatus(orgId, id, status, extra = {}) {
  const appt = await Appointment.findOne({ _id: id, organization: orgId });
  if (!appt) return { error: 'not_found' };

  const allowed = VALID_STATUS_TRANSITIONS[appt.status] || [];
  if (!allowed.includes(status)) {
    return { error: `Cannot transition from '${appt.status}' to '${status}'` };
  }

  const now = new Date();
  const trim = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  appt.status = status;
  const tsField = STATUS_TIMESTAMP[status];
  if (tsField && !appt[tsField]) appt[tsField] = now;
  if (status === 'cancelled') appt.cancellationReason = trim(extra.reason) || appt.cancellationReason;

  appt.statusHistory.push({
    status, at: now,
    note: trim(extra.reason) || trim(extra.note) || undefined,
    byName: trim(extra.byName) || undefined
  });
  await appt.save();

  const provider = await Provider.findById(appt.provider).lean();
  if (status === 'cancelled' || status === 'no_show') await syncGoogle('deleteEvent', appt, provider);
  else if (status === 'confirmed') await syncGoogle('updateEvent', appt, provider);
  emitAppointmentEvent(orgId, 'appointment_updated', { id: String(appt._id), status });

  return { appointment: await getDetail(orgId, id) };
}

/** Move an appointment to a new time (and optionally provider), keeping history. */
async function reschedule(orgId, id, body = {}) {
  const appt = await Appointment.findOne({ _id: id, organization: orgId });
  if (!appt) return { error: 'not_found' };
  if (!ACTIVE_STATUSES.includes(appt.status)) return { error: 'not_reschedulable' };

  const newStart = new Date(body.startAt);
  if (Number.isNaN(newStart.getTime())) return { error: 'invalid_start_time' };

  const newProviderId = body.providerId || appt.provider;
  const service = await Service.findById(appt.service).lean();
  const durationMin = appt.serviceSnapshot?.durationMin || service?.durationMin || 30;
  const newEnd = new Date(newStart.getTime() + durationMin * 60000);

  const free = await availabilityService.isSlotFree({
    orgId, providerId: newProviderId, startAt: newStart, endAt: newEnd,
    service, excludeAppointmentId: appt._id
  });
  if (!free) return { error: 'slot_taken' };

  const prevWhen = appt.startAt;
  if (String(newProviderId) !== String(appt.provider)) {
    const provider = await Provider.findOne({ _id: newProviderId, organization: orgId, isActive: true }).lean();
    if (!provider) return { error: 'provider_not_found' };
    appt.provider = provider._id;
    appt.providerSnapshot = { name: provider.name };
    appt.timezone = provider.timezone || appt.timezone;
  }
  appt.startAt = newStart;
  appt.endAt = newEnd;
  appt.statusHistory.push({
    status: appt.status, at: new Date(),
    note: `Rescheduled from ${new Date(prevWhen).toISOString()}`
  });

  try {
    await appt.save();
  } catch (err) {
    if (err.code === 11000) return { error: 'slot_taken' };
    throw err;
  }

  scheduleReminders(appt);
  const provider = await Provider.findById(appt.provider).lean();
  await syncGoogle('updateEvent', appt, provider);
  emitAppointmentEvent(orgId, 'appointment_updated', { id: String(appt._id), status: appt.status });

  return { appointment: await getDetail(orgId, id) };
}

module.exports = {
  listAppointments,
  getStats,
  getDetail,
  getByInteraction,
  createAppointment,
  updateStatus,
  reschedule,
  VALID_STATUS_TRANSITIONS,
  TAB_STATUS,
  APPOINTMENT_STATUS_LABELS
};
