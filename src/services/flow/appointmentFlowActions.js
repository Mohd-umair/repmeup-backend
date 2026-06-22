'use strict';

/**
 * Appointment flow actions — the booking logic behind the appointment flow nodes
 * (offer_slots / book_appointment / reschedule / cancel). Kept out of the large
 * flowNodeHandlers switch; each function returns `{ variables, branch }` and the
 * handler maps `branch` → outgoing edge via pickEdge (avoids a circular require).
 */

const appointmentService = require('../appointment/appointmentService');
const availabilityService = require('../appointment/availabilityService');
const Appointment = require('../../models/Appointment');
const { sendTextForInteraction } = require('./flowMessageService');
const logger = require('../../config/logger');

const ACTIVE = ['requested', 'confirmed'];

/** Identify the customer from the interaction (channel-aware). */
function customerFromInteraction(interaction) {
  const platform = interaction?.platform;
  const platformId = interaction?.author?.platformId || interaction?.platformUserId || '';
  return {
    channel: ['instagram', 'whatsapp', 'voice'].includes(platform) ? platform : 'manual',
    customerName: interaction?.author?.name || undefined,
    customerPhone: platform === 'whatsapp' ? platformId : undefined,
    instagramUserId: platform === 'instagram' ? platformId : undefined,
    contact: interaction?.contact || undefined
  };
}

/** Find the customer's most recent active appointment on this conversation. */
async function findActiveAppointment(organizationId, interaction) {
  const byThread = await Appointment.findOne({
    organization: organizationId,
    sourceInteraction: interaction?._id,
    status: { $in: ACTIVE }
  }).sort({ startAt: 1 });
  if (byThread) return byThread;

  const cust = customerFromInteraction(interaction);
  const or = [];
  if (cust.customerPhone) or.push({ customerPhone: cust.customerPhone });
  if (cust.instagramUserId) or.push({ instagramUserId: cust.instagramUserId });
  if (!or.length) return null;
  return Appointment.findOne({
    organization: organizationId, status: { $in: ACTIVE }, $or: or
  }).sort({ startAt: 1 });
}

/** Parse a 1-based slot choice from a free-text reply ("2", "option 2", "slot #3"). */
function parseChoiceIndex(text, max) {
  const m = String(text || '').match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return n >= 1 && n <= max ? n : null;
}

function buildSlotsMessage(slots, bodyText) {
  const lines = slots.map((s, i) => `${i + 1}. ${s.timeLabel} — ${s.date}${s.providerName ? ` (with ${s.providerName})` : ''}`);
  const head = bodyText && bodyText.trim() ? bodyText.trim() : 'Here are the next available slots — reply with the number you’d like:';
  return `${head}\n\n${lines.join('\n')}`;
}

// ── Node actions ─────────────────────────────────────────────────────────────

/** Compute + DM the next available slots; remember them for the next reply. */
async function offerSlots(ctx) {
  const { organizationId, interaction } = ctx;
  const config = ctx.node?.config || {};
  if (!config.serviceId) {
    logger.warn('[apptFlow] offer_slots: no serviceId configured');
    return { variables: { slots_offered: 0 }, branch: 'none' };
  }
  const maxSlots = Math.max(1, Math.min(10, Number(config.maxSlots) || 6));
  const result = await availabilityService.getAvailableSlots({
    orgId: organizationId,
    serviceId: config.serviceId,
    providerId: config.providerId || undefined,
    days: Number(config.days) || 7,
    limitPerDay: Number(config.limitPerDay) || undefined
  });
  const slots = (result.slots || []).slice(0, maxSlots);

  if (!slots.length) {
    const txt = config.noSlotsText || 'Sorry, there are no open slots right now. Please try again later. 🙏';
    await sendTextForInteraction(interaction, organizationId, txt).catch(() => {});
    return { variables: { slots_offered: 0 }, branch: 'none' };
  }

  await sendTextForInteraction(interaction, organizationId, buildSlotsMessage(slots, config.bodyText));

  const offered = slots.map((s, i) => ({
    i: i + 1, startAt: s.startAt, providerId: s.providerId, providerName: s.providerName, label: `${s.timeLabel} ${s.date}`
  }));
  return {
    variables: {
      offered_slots: offered,
      offer_service_id: String(config.serviceId),
      slots_offered: offered.length
    },
    branch: 'offered'
  };
}

/** Resolve the chosen slot (from offered list or explicit config) → create appointment. */
async function bookAppointment(ctx) {
  const { organizationId, interaction, enrollment } = ctx;
  const config = ctx.node?.config || {};
  const vars = enrollment?.variables || {};
  const offered = Array.isArray(vars.offered_slots) ? vars.offered_slots : [];

  let chosen = null;
  let serviceId = config.serviceId || vars.offer_service_id;
  if (offered.length) {
    const idx = parseChoiceIndex(interaction?.content, offered.length);
    if (idx) chosen = offered[idx - 1];
  }
  if (!chosen && config.startAt && config.providerId) {
    chosen = { startAt: config.startAt, providerId: config.providerId };
  }
  if (!chosen || !serviceId) {
    return { variables: { booking_error: 'no_slot' }, branch: 'failed' };
  }

  const cust = customerFromInteraction(interaction);
  const result = await appointmentService.createAppointment(organizationId, {
    channel: cust.channel,
    serviceId,
    providerId: chosen.providerId,
    startAt: chosen.startAt,
    customerName: cust.customerName,
    customerPhone: cust.customerPhone,
    instagramUserId: cust.instagramUserId,
    contact: cust.contact,
    sourceInteraction: interaction?._id,
    // 'manual' → business confirms later (requested); default auto-confirms.
    status: config.confirmMode === 'manual' ? 'requested' : 'confirmed'
  });

  if (result.error) {
    logger.info('[apptFlow] book failed', { error: result.error });
    return { variables: { booking_error: result.error }, branch: 'failed' };
  }

  const a = result.appointment;
  return {
    variables: {
      appointment_id: a.id,
      appointment_ref: a.displayRef,
      appointment_when: a.whenLabel,
      service_name: a.serviceName,
      provider_name: a.providerName,
      offered_slots: null
    },
    branch: 'booked'
  };
}

/** Reschedule the customer's active appointment to a newly-chosen slot. */
async function rescheduleAppointment(ctx) {
  const { organizationId, interaction, enrollment } = ctx;
  const appt = await findActiveAppointment(organizationId, interaction);
  if (!appt) return { variables: {}, branch: 'none' };

  const offered = Array.isArray(enrollment?.variables?.offered_slots) ? enrollment.variables.offered_slots : [];
  const idx = parseChoiceIndex(interaction?.content, offered.length);
  if (!offered.length || !idx) return { variables: { reschedule_error: 'no_slot' }, branch: 'failed' };
  const chosen = offered[idx - 1];

  const result = await appointmentService.reschedule(organizationId, appt._id, {
    startAt: chosen.startAt, providerId: chosen.providerId
  });
  if (result.error) return { variables: { reschedule_error: result.error }, branch: 'failed' };

  return {
    variables: {
      appointment_ref: result.appointment.displayRef,
      appointment_when: result.appointment.whenLabel,
      offered_slots: null
    },
    branch: 'done'
  };
}

/** Cancel the customer's active appointment on this thread. */
async function cancelAppointment(ctx) {
  const { organizationId, interaction } = ctx;
  const config = ctx.node?.config || {};
  const appt = await findActiveAppointment(organizationId, interaction);
  if (!appt) return { variables: {}, branch: 'none' };

  const result = await appointmentService.updateStatus(organizationId, appt._id, 'cancelled', {
    reason: config.reason || 'Cancelled by customer'
  });
  if (result.error) return { variables: { cancel_error: result.error }, branch: 'failed' };

  return { variables: { cancelled_ref: appt.displayRef }, branch: 'done' };
}

module.exports = {
  offerSlots,
  bookAppointment,
  rescheduleAppointment,
  cancelAppointment
};
