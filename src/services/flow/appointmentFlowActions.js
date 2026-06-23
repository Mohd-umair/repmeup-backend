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

/** After this many invalid replies in a row, gracefully end the booking flow. */
const MAX_APPT_MISSES = 2;

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

// Interactive-list row id prefixes — the tapped row id arrives as interaction.metadata.buttonPayload.
const SVC_PREFIX = 'apptsvc';
const SLOT_PREFIX = 'apptslot';

/** Extract our row id value, e.g. buttonPayload "apptslot:3" → "3". */
function payloadValue(interaction, prefix) {
  const p = interaction?.metadata?.buttonPayload;
  if (typeof p === 'string' && p.startsWith(prefix + ':')) return p.slice(prefix.length + 1);
  return null;
}

/** WhatsApp connection + recipient for interactive sends (null on IG / no connection). */
async function waTarget(organizationId, interaction) {
  if (interaction?.platform !== 'whatsapp') return null;
  const conn = await require('./flowMessageService').getConnection(organizationId, 'whatsapp');
  const to = interaction?.author?.platformId || interaction?.platformUserId;
  return conn && to ? { conn, to } : null;
}

/** Services as a WhatsApp interactive list (tap to pick); numbered-text fallback elsewhere. */
async function sendServiceList(organizationId, interaction, services, head) {
  const t = await waTarget(organizationId, interaction);
  if (t) {
    try {
      const wa = require('../../integrations/whatsapp/whatsappService');
      const rows = services.map((s) => {
        const meta = s.durationMin ? `${s.durationMin} min${s.price ? ` · ${s.price} ${s.currency || ''}`.trim() : ''}` : '';
        return { id: `${SVC_PREFIX}:${s._id}`, title: String(s.name).slice(0, 24), description: meta ? meta.slice(0, 72) : undefined };
      });
      await wa.sendListMessage(t.conn, t.to, {
        bodyText: String(head).slice(0, 1024), buttonText: 'View services',
        sections: [{ title: 'Services', rows }]
      });
      return;
    } catch (e) { logger.warn('[apptFlow] service list send failed → text', { error: e.message }); }
  }
  const msg = `${head}\n\n${services.map((s, i) => `${i + 1}. ${s.name}`).join('\n')}\n\nReply with the number.`;
  await sendTextForInteraction(interaction, organizationId, msg).catch(() => {});
}

/** Slots as a WhatsApp interactive list (tap to pick); numbered-text fallback elsewhere. */
async function sendSlotList(organizationId, interaction, slots, head) {
  const t = await waTarget(organizationId, interaction);
  if (t) {
    try {
      const wa = require('../../integrations/whatsapp/whatsappService');
      const rows = slots.map((s, i) => ({
        id: `${SLOT_PREFIX}:${i + 1}`,
        title: String(s.timeLabel).slice(0, 24),
        description: `${s.date}${s.providerName ? ` · ${s.providerName}` : ''}`.slice(0, 72)
      }));
      const headText = (head && head.trim()) || 'Here are the next available times — tap one:';
      await wa.sendListMessage(t.conn, t.to, {
        bodyText: headText.slice(0, 1024), buttonText: 'View times',
        sections: [{ title: 'Available times', rows }]
      });
      return;
    } catch (e) { logger.warn('[apptFlow] slot list send failed → text', { error: e.message }); }
  }
  await sendTextForInteraction(interaction, organizationId, buildSlotsMessage(slots, head)).catch(() => {});
}

// ── Node actions ─────────────────────────────────────────────────────────────

/**
 * List ALL active services and ask the customer to pick one — so a single flow
 * can handle every service (no per-service flow). Remembers the numbered list so
 * the next "Offer slots" node knows which service the customer chose.
 */
async function offerServices(ctx) {
  const { organizationId, interaction } = ctx;
  const config = ctx.node?.config || {};
  const Service = require('../../models/Service');
  const services = await Service.find({ organization: organizationId, isActive: true }).sort({ name: 1 }).lean();

  if (!services.length) {
    const txt = config.noServicesText || 'Sorry, no services are available to book right now. Please try again later. 🙏';
    await sendTextForInteraction(interaction, organizationId, txt).catch(() => {});
    return { variables: { services_offered: 0 }, branch: 'none' };
  }

  const top = services.slice(0, 10);
  const list = top.map((s, i) => ({ i: i + 1, id: String(s._id), name: s.name }));
  const head = (config.bodyText && config.bodyText.trim()) || 'Which service would you like to book?';
  await sendServiceList(organizationId, interaction, top, head);

  return { variables: { offered_services: list, services_offered: list.length, appt_misses: 0 }, branch: 'offered' };
}

/** Compute + DM the next available slots; remember them for the next reply. */
async function offerSlots(ctx) {
  const { organizationId, interaction, enrollment } = ctx;
  const config = ctx.node?.config || {};

  // Resolve the service: an explicit config service (single-service flow), the
  // service already resolved earlier in this conversation (stable across retries),
  // or the one the customer just picked from a preceding "Ask which service" node.
  // Service from: explicit config, the tapped service row (interactive list),
  // a service already locked earlier (stable across retries), or a typed number.
  let serviceId = config.serviceId
    || payloadValue(interaction, SVC_PREFIX)
    || enrollment?.variables?.appointment_service_id;
  if (!serviceId) {
    const offeredServices = Array.isArray(enrollment?.variables?.offered_services)
      ? enrollment.variables.offered_services : [];
    if (offeredServices.length) {
      const idx = parseChoiceIndex(interaction?.content, offeredServices.length);
      if (idx) serviceId = offeredServices[idx - 1].id;
    }
  }
  if (!serviceId) {
    // Fallback: the customer sent something other than a valid service pick.
    // Cap the nudges so they aren't stuck getting "tap a service" on every message.
    const misses = (enrollment?.variables?.appt_misses || 0) + 1;
    if (misses > MAX_APPT_MISSES) {
      await sendTextForInteraction(interaction, organizationId,
        'No problem! 🙏 Message "book" whenever you’re ready and we’ll start over.').catch(() => {});
      return { variables: { appt_misses: 0, slots_offered: 0 }, branch: 'none', end: true };
    }
    await sendTextForInteraction(
      interaction, organizationId,
      config.invalidServiceText || 'Sorry, I didn’t catch that. 🙏 Please tap a service from the list above (or reply with its number).'
    ).catch(() => {});
    return { variables: { appt_misses: misses, slots_offered: 0, invalid_pick: true }, branch: 'none' };
  }

  const maxSlots = Math.max(1, Math.min(10, Number(config.maxSlots) || 6));
  const result = await availabilityService.getAvailableSlots({
    orgId: organizationId,
    serviceId,
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

  await sendSlotList(organizationId, interaction, slots, config.bodyText);

  const offered = slots.map((s, i) => ({
    i: i + 1, startAt: s.startAt, providerId: s.providerId, providerName: s.providerName, label: `${s.timeLabel} ${s.date}`
  }));
  return {
    variables: {
      offered_slots: offered,
      offer_service_id: String(serviceId),
      appointment_service_id: String(serviceId),
      slots_offered: offered.length,
      appt_misses: 0
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
  const serviceId = config.serviceId || vars.offer_service_id;
  // Tapped time row (interactive list) takes priority, then a typed number.
  if (offered.length) {
    const tapped = payloadValue(interaction, SLOT_PREFIX);
    const n = tapped ? parseInt(tapped, 10) : parseChoiceIndex(interaction?.content, offered.length);
    if (n >= 1 && n <= offered.length) chosen = offered[n - 1];
  }
  if (!chosen && config.startAt && config.providerId) {
    chosen = { startAt: config.startAt, providerId: config.providerId };
  }
  if (!chosen || !serviceId) {
    // Fallback: not a valid time pick. Cap nudges so they don't loop forever.
    const misses = (vars.appt_misses || 0) + 1;
    if (misses > MAX_APPT_MISSES) {
      await sendTextForInteraction(interaction, organizationId,
        'No problem! 🙏 Message "book" whenever you’re ready to try again.').catch(() => {});
      return { variables: { appt_misses: 0, booking_error: 'gaveup' }, branch: 'failed', end: true };
    }
    await sendTextForInteraction(
      interaction, organizationId,
      'Sorry, I didn’t catch that. 🙏 Please tap a time from the list above (or reply with its number).'
    ).catch(() => {});
    return { variables: { appt_misses: misses, booking_error: 'no_slot', invalid_pick: true }, branch: 'failed' };
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
      offered_slots: null,
      appt_misses: 0
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
  offerServices,
  offerSlots,
  bookAppointment,
  rescheduleAppointment,
  cancelAppointment
};
