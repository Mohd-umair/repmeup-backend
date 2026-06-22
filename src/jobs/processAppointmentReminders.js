'use strict';

/**
 * Appointment reminders + no-show sweep (periodic, restart-safe).
 *
 * Runs every ~10 min. For each upcoming active appointment it sends any due
 * reminders (per the org's reminderOffsetsMins, e.g. 24h + 1h before) exactly
 * once, and auto-marks no_show once an appointment is past its start + grace and
 * still un-completed. Idempotent: reminders are logged on appointment.reminders[]
 * so a re-run never double-sends.
 */

const Appointment = require('../models/Appointment');
const Organization = require('../models/Organization');
const logger = require('../config/logger');

const DEFAULT_OFFSETS = [1440, 60];
const DEFAULT_GRACE = 20;

/** Cache org appointmentSettings within a single sweep. */
async function settingsFor(orgCache, organizationId) {
  const key = String(organizationId);
  if (orgCache.has(key)) return orgCache.get(key);
  const org = await Organization.findById(organizationId).select('appointmentSettings').lean();
  const s = org?.appointmentSettings || {};
  orgCache.set(key, s);
  return s;
}

function reminderText(appt) {
  const ref = appt.displayRef ? ` (${appt.displayRef})` : '';
  const svc = appt.serviceSnapshot?.name || 'your appointment';
  const tz = appt.timezone || 'Asia/Kolkata';
  let when = '';
  try {
    when = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }).format(new Date(appt.startAt));
  } catch { when = new Date(appt.startAt).toUTCString(); }
  return `⏰ Reminder: your ${svc} appointment is on ${when}${ref}.\n\nReply "reschedule" to change it or "cancel" if you can’t make it. See you soon! 🙌`;
}

async function sendReminder(appt) {
  if (!appt.sourceInteraction) return { sent: false, reason: 'no_thread' };
  const Interaction = require('../models/Interaction');
  const interaction = await Interaction.findById(appt.sourceInteraction)
    .select('platform author platformId metadata contact').lean();
  if (!interaction) return { sent: false, reason: 'interaction_gone' };
  const { sendTextForInteraction } = require('../services/flow/flowMessageService');
  const res = await sendTextForInteraction(interaction, appt.organization, reminderText(appt));
  return { sent: !!res?.sent, channel: interaction.platform };
}

/**
 * One sweep. Returns counts for observability/tests.
 */
async function processAppointmentReminders() {
  const now = new Date();
  const orgCache = new Map();
  let remindersSent = 0;
  let noShows = 0;

  // ── Reminders: upcoming active appointments within the next 48h ────────────
  const horizon = new Date(now.getTime() + 48 * 3600000);
  const upcoming = await Appointment.find({
    status: { $in: ['requested', 'confirmed'] },
    startAt: { $gt: now, $lte: horizon }
  }).select('organization status startAt timezone displayRef serviceSnapshot sourceInteraction reminders').lean();

  for (const appt of upcoming) {
    const settings = await settingsFor(orgCache, appt.organization);
    if (settings.enabled === false) continue;
    const offsets = Array.isArray(settings.reminderOffsetsMins) && settings.reminderOffsetsMins.length
      ? settings.reminderOffsetsMins : DEFAULT_OFFSETS;
    const already = new Set((appt.reminders || []).map((r) => r.offsetMin));

    for (const offset of offsets) {
      if (already.has(offset)) continue;
      const dueAt = new Date(appt.startAt).getTime() - offset * 60000;
      if (now.getTime() < dueAt) continue;            // not due yet
      if (now.getTime() >= new Date(appt.startAt).getTime()) continue; // started already

      // Atomic claim so a concurrent/duplicate run can't double-send.
      const claim = await Appointment.updateOne(
        { _id: appt._id, 'reminders.offsetMin': { $ne: offset } },
        { $push: { reminders: { offsetMin: offset, sentAt: new Date(), channel: null } } }
      );
      if (!claim.modifiedCount) continue;

      try {
        const r = await sendReminder(appt);
        if (r.channel) {
          await Appointment.updateOne(
            { _id: appt._id, 'reminders.offsetMin': offset },
            { $set: { 'reminders.$.channel': r.channel } }
          );
        }
        if (r.sent) remindersSent++;
      } catch (err) {
        logger.warn('[apptReminders] send failed', { appt: String(appt._id), error: err.message });
      }
      break; // at most one reminder per appointment per sweep
    }
  }

  // ── No-show: past start + grace, still active ──────────────────────────────
  const pastActive = await Appointment.find({
    status: { $in: ['requested', 'confirmed'] },
    startAt: { $lt: now }
  }).select('organization startAt').lean();

  const appointmentService = require('../services/appointment/appointmentService');
  for (const appt of pastActive) {
    const settings = await settingsFor(orgCache, appt.organization);
    const grace = settings.noShowGraceMins != null ? settings.noShowGraceMins : DEFAULT_GRACE;
    if (now.getTime() < new Date(appt.startAt).getTime() + grace * 60000) continue;
    const res = await appointmentService.updateStatus(appt.organization, appt._id, 'no_show', { note: 'Auto: no-show after grace period' });
    if (!res.error) noShows++;
  }

  logger.info('[apptReminders] sweep done', { remindersSent, noShows, scanned: upcoming.length });
  return { remindersSent, noShows };
}

module.exports = processAppointmentReminders;
