'use strict';

/**
 * Appointment Agent Service — the AI booking counterpart of commerceAgentService.
 *
 * When an org has appointmentSettings.enabled + aiBookingEnabled, this evaluates
 * inbound WhatsApp messages for booking intent and conversationally books an
 * appointment: resolve service → offer slots → book the picked slot → confirm.
 * Also handles "cancel" and "reschedule" for the customer's active appointment.
 *
 * Conversation state (pending service/slot offer) lives in
 * AppointmentConversationState, keyed by (org, customerKey), TTL-expiring after a
 * day. Gated by the org toggle here, plus a per-customer daily cap. Best-effort
 * and non-fatal.
 *
 * Called from: whatsappWebhookService (beside tryAutonomousCommerceAction).
 */

const logger = require('../../config/logger');

const BOOK_KEYWORDS = ['book', 'appointment', 'appoint', 'slot', 'schedule', 'timing',
  'available', 'availability', 'reserve', 'booking', 'appt'];
const CANCEL_KEYWORDS = ['cancel', 'cancellation'];
const RESCHEDULE_KEYWORDS = ['reschedule', 'change time', 'change my', 'move my', 'postpone'];

function hasAny(text, words) {
  const l = String(text || '').toLowerCase();
  return words.some((w) => l.includes(w));
}

/** Parse a 1-based choice from a reply ("2", "option 2"). */
function parseChoice(text, max) {
  const m = String(text || '').match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return n >= 1 && n <= max ? n : null;
}

function slotsMessage(slots, head) {
  const lines = slots.map((s, i) => `${i + 1}. ${s.label}${s.providerName ? ` (with ${s.providerName})` : ''}`);
  return `${head}\n\n${lines.join('\n')}\n\nReply with the number you’d like.`;
}

async function send(connection, to, message) {
  try {
    const whatsappService = require('../../integrations/whatsapp/whatsappService');
    await whatsappService.sendTextMessage(connection, to, message);
  } catch (err) {
    logger.warn('[apptAgent] send failed (non-fatal)', { error: err.message });
  }
}

function stateModel() {
  return require('../../models/AppointmentConversationState');
}
async function getOffer(organizationId, customerKey) {
  return stateModel().findOne({ organization: organizationId, customerKey }).lean();
}
async function setOffer(organizationId, customerKey, offer) {
  await stateModel().updateOne(
    { organization: organizationId, customerKey },
    { $set: { ...offer, organization: organizationId, customerKey, updatedAt: new Date() } },
    { upsert: true }
  );
}
async function clearOffer(organizationId, customerKey) {
  await stateModel().deleteOne({ organization: organizationId, customerKey });
}

/** Compute + send slots for a service; persist the pending offer. */
async function offerAndStore({ organizationId, interaction, connection, senderId, service, stage, appointmentId }) {
  const availabilityService = require('../appointment/availabilityService');
  const { slots } = await availabilityService.getAvailableSlots({
    orgId: organizationId, serviceId: service._id, days: 7, limitPerDay: 3
  });
  const top = (slots || []).slice(0, 6);
  if (!top.length) {
    await send(connection, senderId, `Sorry, no open slots for ${service.name} right now. Please try again later. 🙏`);
    await clearOffer(organizationId, senderId);
    return;
  }
  const offered = top.map((s, i) => ({ i: i + 1, startAt: s.startAt, providerId: s.providerId, providerName: s.providerName, label: `${s.timeLabel} · ${s.date}` }));
  await setOffer(organizationId, senderId, {
    stage: stage || 'awaiting_slot',
    serviceId: String(service._id),
    serviceName: service.name,
    slots: offered,
    appointmentId: appointmentId ? String(appointmentId) : undefined,
    sourceInteraction: interaction?._id
  });
  const head = stage === 'awaiting_reschedule_slot'
    ? `Sure — here are the next available times for ${service.name}:`
    : `Here are the next available times for ${service.name}:`;
  await send(connection, senderId, slotsMessage(offered, head));
}

/** Resolve a service the customer named, or the only active one. */
async function resolveService(organizationId, text) {
  const Service = require('../../models/Service');
  const services = await Service.find({ organization: organizationId, isActive: true }).lean();
  if (!services.length) return { services: [] };
  const l = String(text || '').toLowerCase();
  const named = services.find((s) => l.includes(s.name.toLowerCase()));
  if (named) return { service: named, services };
  if (services.length === 1) return { service: services[0], services };
  return { services }; // ambiguous → caller asks which
}

async function findActiveAppointment(organizationId, senderId, interaction) {
  const Appointment = require('../../models/Appointment');
  return Appointment.findOne({
    organization: organizationId,
    status: { $in: ['requested', 'confirmed'] },
    $or: [{ sourceInteraction: interaction?._id }, { customerPhone: senderId }]
  }).sort({ startAt: 1 });
}

/**
 * Main entry — best-effort, returns true if the agent handled the message.
 */
async function tryAutonomousBooking({ organizationId, senderId, text, connection, interaction }) {
  try {
    const Organization = require('../../models/Organization');
    const org = await Organization.findById(organizationId).select('appointmentSettings').lean();
    const s = org?.appointmentSettings;
    if (!s?.enabled || !s?.aiBookingEnabled) return false;

    const offer = await getOffer(organizationId, senderId);

    // 1) Continuation of a pending offer (customer replied with a number).
    if (offer && offer.stage) {
      if (offer.stage === 'awaiting_service' && Array.isArray(offer.services)) {
        const idx = parseChoice(text, offer.services.length);
        if (idx) {
          const Service = require('../../models/Service');
          const service = await Service.findOne({ _id: offer.services[idx - 1].id, organization: organizationId, isActive: true }).lean();
          if (service) { await offerAndStore({ organizationId, interaction, connection, senderId, service }); return true; }
        }
      }
      if ((offer.stage === 'awaiting_slot' || offer.stage === 'awaiting_reschedule_slot') && Array.isArray(offer.slots)) {
        const idx = parseChoice(text, offer.slots.length);
        if (idx) {
          const chosen = offer.slots[idx - 1];
          const appointmentService = require('../appointment/appointmentService');

          if (offer.stage === 'awaiting_reschedule_slot' && offer.appointmentId) {
            const r = await appointmentService.reschedule(organizationId, offer.appointmentId, { startAt: chosen.startAt, providerId: chosen.providerId });
            if (r.error === 'slot_taken') { await reoffer(organizationId, interaction, connection, senderId, offer); return true; }
            await clearOffer(organizationId, senderId);
            await send(connection, senderId, r.error ? 'Sorry, I couldn’t reschedule that. Please try again.' : `✅ Rescheduled! ${r.appointment.displayRef} — now ${r.appointment.whenLabel}. See you then! 🙌`);
            return true;
          }

          // Daily cap on autonomous bookings.
          const Appointment = require('../../models/Appointment');
          const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
          const made = await Appointment.countDocuments({ organization: organizationId, customerPhone: senderId, createdAt: { $gte: dayStart } });
          if (made >= (s.aiMaxBookingsPerUserPerDay || 3)) {
            await clearOffer(organizationId, senderId);
            await send(connection, senderId, 'You’ve reached the booking limit for today. Please contact us to book more. 🙏');
            return true;
          }

          const r = await appointmentService.createAppointment(organizationId, {
            channel: 'whatsapp', serviceId: offer.serviceId, providerId: chosen.providerId, startAt: chosen.startAt,
            customerName: interaction?.author?.name, customerPhone: senderId, contact: interaction?.contact,
            sourceInteraction: interaction?._id, status: 'confirmed'
          });
          if (r.error === 'slot_taken') { await reoffer(organizationId, interaction, connection, senderId, offer); return true; }
          await clearOffer(organizationId, senderId);
          await send(connection, senderId, r.error
            ? 'Sorry, I couldn’t book that slot. Please try again.'
            : `✅ You’re booked! ${r.appointment.displayRef}\n🗓️ ${r.appointment.serviceName} on ${r.appointment.whenLabel}\nWe’ll remind you. See you! 🙌`);
          return true;
        }
      }
    }

    // 2) Cancel intent.
    if (hasAny(text, CANCEL_KEYWORDS)) {
      const appt = await findActiveAppointment(organizationId, senderId, interaction);
      if (!appt) { await send(connection, senderId, 'You don’t have an upcoming appointment to cancel.'); return true; }
      const appointmentService = require('../appointment/appointmentService');
      await appointmentService.updateStatus(organizationId, appt._id, 'cancelled', { reason: 'Cancelled by customer (AI)' });
      await send(connection, senderId, `Done — ${appt.displayRef} is cancelled. Reply "book" anytime to rebook. 🙏`);
      return true;
    }

    // 3) Reschedule intent → offer slots for the active appointment's service.
    if (hasAny(text, RESCHEDULE_KEYWORDS)) {
      const appt = await findActiveAppointment(organizationId, senderId, interaction);
      if (!appt) { await send(connection, senderId, 'You don’t have an upcoming appointment to reschedule. Reply "book" to make one.'); return true; }
      const Service = require('../../models/Service');
      const service = await Service.findById(appt.service).lean();
      if (!service) return false;
      await offerAndStore({ organizationId, interaction, connection, senderId, service, stage: 'awaiting_reschedule_slot', appointmentId: appt._id });
      return true;
    }

    // 4) Fresh booking intent.
    if (hasAny(text, BOOK_KEYWORDS)) {
      const { service, services } = await resolveService(organizationId, text);
      if (!services.length) return false; // no services configured → let normal AI handle
      if (service) { await offerAndStore({ organizationId, interaction, connection, senderId, service }); return true; }
      // Ambiguous → ask which service.
      const list = services.slice(0, 8).map((sv, i) => ({ i: i + 1, id: String(sv._id), name: sv.name }));
      await setOffer(organizationId, senderId, { stage: 'awaiting_service', services: list, sourceInteraction: interaction?._id });
      await send(connection, senderId, `Which service would you like to book?\n\n${list.map((x) => `${x.i}. ${x.name}`).join('\n')}\n\nReply with the number.`);
      return true;
    }

    return false;
  } catch (err) {
    logger.warn('[apptAgent] tryAutonomousBooking failed (non-fatal)', { error: err.message });
    return false;
  }
}

/** Re-offer fresh slots when a pick lost the race. */
async function reoffer(organizationId, interaction, connection, senderId, offer) {
  const Service = require('../../models/Service');
  const service = await Service.findById(offer.serviceId).lean();
  if (!service) { await clearOffer(organizationId, senderId); return; }
  await send(connection, senderId, 'Oops, that time was just taken. 😅 Here are fresh options:');
  await offerAndStore({
    organizationId, interaction, connection, senderId, service,
    stage: offer.stage, appointmentId: offer.appointmentId
  });
}

module.exports = { tryAutonomousBooking };
