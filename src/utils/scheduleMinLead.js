const SCHEDULE_MIN_LEAD_MS = 15 * 60 * 1000;

function minAllowedScheduleTime() {
  return Date.now() + SCHEDULE_MIN_LEAD_MS;
}

/**
 * Enforce schedule time is at least {@link SCHEDULE_MIN_LEAD_MS} in the future.
 *
 * @param {string|Date|number} scheduledForRaw
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function assertScheduledForMinLead(scheduledForRaw) {
  const when = new Date(scheduledForRaw);
  if (Number.isNaN(when.getTime())) {
    return { ok: false, message: 'Invalid schedule time' };
  }
  if (when.getTime() < minAllowedScheduleTime()) {
    return {
      ok: false,
      message: 'Schedule time must be at least 15 minutes from now'
    };
  }
  return { ok: true };
}

module.exports = {
  SCHEDULE_MIN_LEAD_MS,
  assertScheduledForMinLead
};
