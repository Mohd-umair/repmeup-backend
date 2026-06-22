'use strict';

/**
 * Availability engine — computes bookable slots for a service (+ optional provider)
 * across a date range, honoring provider weekly availability (falling back to the
 * org businessHours), buffers, time-off, existing appointments, min-notice /
 * max-advance windows, and (when connected) Google Calendar busy blocks.
 *
 * All wall-clock hours are interpreted in the provider's timezone (or the org
 * default) and returned as UTC instants, so the rest of the system stays tz-safe.
 */

const Organization = require('../../models/Organization');
const Service = require('../../models/Service');
const Provider = require('../../models/Provider');
const Appointment = require('../../models/Appointment');
const logger = require('../../config/logger');

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// ── Timezone helpers (no external deps) ──────────────────────────────────────

/** Offset (tz wall-clock minus UTC) in ms at a given instant. */
function tzOffsetMs(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const map = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return asUTC - date.getTime();
}

/** Convert a wall-clock time in `tz` to the corresponding UTC Date (DST-safe). */
function zonedWallTimeToUtc(year, month, day, hour, minute, tz) {
  const wallAsUTC = Date.UTC(year, month - 1, day, hour, minute);
  let offset = tzOffsetMs(tz, new Date(wallAsUTC));
  let utc = wallAsUTC - offset;
  // Refine once for DST boundaries.
  offset = tzOffsetMs(tz, new Date(utc));
  utc = wallAsUTC - offset;
  return new Date(utc);
}

/** { year, month, day, weekday } for an instant as seen in `tz`. */
function zonedDateParts(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const map = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  return {
    year: +map.year,
    month: +map.month,
    day: +map.day,
    weekday: String(map.weekday || '').toLowerCase()
  };
}

/** "HH:mm" → minutes since midnight, or null. */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// ── Window resolution ────────────────────────────────────────────────────────

/**
 * The provider's open window for a weekday: prefer the provider's own
 * weeklyAvailability; if that day is missing/disabled, fall back to the org
 * businessHours (when enabled). Returns { startMin, endMin } or null (closed).
 */
function resolveDayWindow(provider, weekday, businessHours) {
  const pw = provider.weeklyAvailability?.[weekday];
  if (pw && pw.enabled !== false) {
    const startMin = toMinutes(pw.start);
    const endMin = toMinutes(pw.end);
    if (startMin != null && endMin != null && endMin > startMin) return { startMin, endMin };
  }
  if (businessHours?.enabled) {
    const bh = businessHours.schedule?.[weekday];
    if (bh && bh.enabled !== false) {
      const startMin = toMinutes(bh.start);
      const endMin = toMinutes(bh.end);
      if (startMin != null && endMin != null && endMin > startMin) return { startMin, endMin };
    }
  }
  return null;
}

/** Two [start, end) intervals overlap? */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// ── Provider resolution ──────────────────────────────────────────────────────

async function resolveProvidersForService(orgId, service, providerId) {
  const baseQuery = { organization: orgId, isActive: true };
  if (providerId) {
    const p = await Provider.findOne({ ...baseQuery, _id: providerId }).lean();
    return p ? [p] : [];
  }
  // Prefer providers explicitly linked to the service (either direction).
  const linkedIds = (service.providers || []).map((id) => String(id));
  const query = linkedIds.length
    ? { ...baseQuery, $or: [{ _id: { $in: linkedIds } }, { services: service._id }] }
    : { ...baseQuery, services: service._id };
  let providers = await Provider.find(query).lean();
  // Fallback: if nobody is linked yet, any active provider can take it.
  if (!providers.length) providers = await Provider.find(baseQuery).lean();
  return providers;
}

// ── Optional Google busy hook (no-op until Phase 5) ──────────────────────────

async function googleBusyIntervals(provider, fromUtc, toUtc) {
  if (!provider.google?.connected) return [];
  try {
    const googleCalendarService = require('../../integrations/google/googleCalendarService');
    if (typeof googleCalendarService.freeBusy !== 'function') return [];
    return await googleCalendarService.freeBusy(provider, fromUtc, toUtc);
  } catch (err) {
    logger.warn('[availability] google busy lookup failed (non-fatal)', { error: err.message });
    return [];
  }
}

// ── Core ─────────────────────────────────────────────────────────────────────

/**
 * Compute available slots.
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {string} opts.serviceId
 * @param {string} [opts.providerId]      restrict to one provider
 * @param {Date|string} [opts.from]       range start (default: now)
 * @param {number} [opts.days]            number of days to scan (default 7)
 * @param {number} [opts.limitPerDay]     cap slots returned per provider per day
 * @returns {Promise<{ service, slots: Array, byDate: object, error?: string }>}
 */
async function getAvailableSlots(opts = {}) {
  const { orgId, serviceId, providerId, limitPerDay } = opts;

  const [org, service] = await Promise.all([
    Organization.findById(orgId).select('appointmentSettings businessHours').lean(),
    Service.findOne({ _id: serviceId, organization: orgId, isActive: true }).lean()
  ]);
  if (!service) return { error: 'service_not_found', slots: [], byDate: {} };

  const settings = org?.appointmentSettings || {};
  const businessHours = org?.businessHours;
  const granularity = Math.max(5, settings.slotGranularityMin || 15);
  const minNoticeMs = (settings.minNoticeMins ?? 120) * 60000;
  const maxAdvanceDays = settings.maxAdvanceDays || 30;
  const defaultTz = settings.defaultTimezone || 'Asia/Kolkata';

  const durationMin = service.durationMin || 30;
  const bufBefore = service.bufferBeforeMin || 0;
  const bufAfter = service.bufferAfterMin || 0;

  const now = new Date();
  const from = opts.from ? new Date(opts.from) : now;
  const days = Math.min(maxAdvanceDays, Math.max(1, opts.days || 7));
  const earliest = new Date(now.getTime() + minNoticeMs);
  const latest = new Date(now.getTime() + maxAdvanceDays * 86400000);

  const providers = await resolveProvidersForService(orgId, service, providerId);
  if (!providers.length) return { error: 'no_provider', slots: [], byDate: {} };

  // Existing active appointments across all candidate providers in the window.
  const rangeStart = new Date(Math.min(from.getTime(), earliest.getTime()) - 86400000);
  const rangeEnd = new Date(from.getTime() + days * 86400000 + 86400000);
  const existing = await Appointment.find({
    organization: orgId,
    provider: { $in: providers.map((p) => p._id) },
    status: { $in: ['requested', 'confirmed'] },
    startAt: { $lt: rangeEnd },
    endAt: { $gt: rangeStart }
  }).select('provider startAt endAt').lean();

  const busyByProvider = new Map();
  for (const p of providers) busyByProvider.set(String(p._id), []);
  for (const a of existing) {
    const arr = busyByProvider.get(String(a.provider));
    if (arr) arr.push({ start: new Date(a.startAt).getTime(), end: new Date(a.endAt).getTime() });
  }

  const slots = [];
  const byDate = {};

  for (const provider of providers) {
    const tz = provider.timezone || defaultTz;
    const pBusy = busyByProvider.get(String(provider._id)) || [];
    const timeOff = (provider.timeOff || []).map((t) => ({
      start: new Date(t.from).getTime(), end: new Date(t.to).getTime()
    }));
    const gBusy = await googleBusyIntervals(provider, from, latest);

    for (let dOff = 0; dOff < days; dOff++) {
      const dayAnchor = new Date(from.getTime() + dOff * 86400000);
      const { year, month, day, weekday } = zonedDateParts(dayAnchor, tz);
      const window = resolveDayWindow(provider, weekday, businessHours);
      if (!window) continue;

      let perDay = 0;
      for (let m = window.startMin; m + durationMin <= window.endMin; m += granularity) {
        const startAt = zonedWallTimeToUtc(year, month, day, Math.floor(m / 60), m % 60, tz);
        const endAt = new Date(startAt.getTime() + durationMin * 60000);

        if (startAt < earliest || startAt > latest) continue;

        // Block window for this candidate includes the service's own buffers.
        const blockStart = startAt.getTime() - bufBefore * 60000;
        const blockEnd = endAt.getTime() + bufAfter * 60000;

        const clash =
          pBusy.some((b) => overlaps(blockStart, blockEnd, b.start, b.end)) ||
          timeOff.some((b) => overlaps(startAt.getTime(), endAt.getTime(), b.start, b.end)) ||
          gBusy.some((b) => overlaps(startAt.getTime(), endAt.getTime(), b.start, b.end));
        if (clash) continue;

        const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const slot = {
          providerId: String(provider._id),
          providerName: provider.name,
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          date: dateKey,
          timeLabel: new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hour: 'numeric', minute: '2-digit'
          }).format(startAt),
          timezone: tz
        };
        slots.push(slot);
        (byDate[dateKey] = byDate[dateKey] || []).push(slot);

        if (limitPerDay && ++perDay >= limitPerDay) break;
      }
    }
  }

  slots.sort((a, b) => a.startAt.localeCompare(b.startAt));
  return {
    service: { id: String(service._id), name: service.name, durationMin, price: service.price, currency: service.currency },
    slots,
    byDate
  };
}

/**
 * Is a specific slot still free for a provider? Used as the atomic re-check at
 * booking time (the unique partial index is the final guard).
 */
async function isSlotFree({ orgId, providerId, startAt, endAt, service, excludeAppointmentId }) {
  const bufBefore = service?.bufferBeforeMin || 0;
  const bufAfter = service?.bufferAfterMin || 0;
  const blockStart = new Date(new Date(startAt).getTime() - bufBefore * 60000);
  const blockEnd = new Date(new Date(endAt).getTime() + bufAfter * 60000);

  const query = {
    organization: orgId,
    provider: providerId,
    status: { $in: ['requested', 'confirmed'] },
    startAt: { $lt: blockEnd },
    endAt: { $gt: blockStart }
  };
  if (excludeAppointmentId) query._id = { $ne: excludeAppointmentId };

  const clash = await Appointment.exists(query);
  if (clash) return false;

  // Respect provider time-off too.
  const provider = await Provider.findOne({ _id: providerId, organization: orgId })
    .select('timeOff').lean();
  const s = new Date(startAt).getTime();
  const e = new Date(endAt).getTime();
  const inTimeOff = (provider?.timeOff || []).some((t) =>
    overlaps(s, e, new Date(t.from).getTime(), new Date(t.to).getTime()));
  return !inTimeOff;
}

module.exports = {
  getAvailableSlots,
  isSlotFree,
  // exported for unit tests
  zonedWallTimeToUtc,
  zonedDateParts,
  resolveDayWindow,
  toMinutes
};
