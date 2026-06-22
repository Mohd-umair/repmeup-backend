'use strict';

const mongoose = require('mongoose');

/**
 * Provider — a staff member who delivers services at scheduled times
 * (doctor, therapist, stylist…). Each provider owns their own weekly
 * availability and time-off, and may optionally sync a Google Calendar.
 *
 * The weekly availability mirrors Organization.businessHours.schedule so the
 * same editor/UX can be reused; an unset day falls back to the org businessHours.
 */

/** One bookable window in a day, e.g. { start: '09:00', end: '13:00' }. */
const dayWindowSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: true },
  start: { type: String, default: '09:00' }, // "HH:mm" (24h, provider/org tz)
  end: { type: String, default: '18:00' }
}, { _id: false });

/** A block of unavailable time (leave, holiday, lunch on a specific date). */
const timeOffSchema = new mongoose.Schema({
  from: { type: Date, required: true }, // UTC instant
  to: { type: Date, required: true },   // UTC instant
  reason: { type: String, trim: true }
}, { _id: false });

const providerSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },

  name: { type: String, required: true, trim: true },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },
  title: { type: String, trim: true }, // e.g. "Senior Therapist"
  avatarUrl: { type: String, trim: true },

  /** Services this provider can deliver. */
  services: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Service' }],

  /** IANA timezone the provider's hours are expressed in. */
  timezone: { type: String, default: 'Asia/Kolkata', trim: true },

  /**
   * Weekly recurring availability keyed by weekday. A day left undefined/disabled
   * falls back to the org businessHours during slot computation.
   */
  weeklyAvailability: {
    sunday: { type: dayWindowSchema, default: () => ({ enabled: false }) },
    monday: { type: dayWindowSchema, default: () => ({}) },
    tuesday: { type: dayWindowSchema, default: () => ({}) },
    wednesday: { type: dayWindowSchema, default: () => ({}) },
    thursday: { type: dayWindowSchema, default: () => ({}) },
    friday: { type: dayWindowSchema, default: () => ({}) },
    saturday: { type: dayWindowSchema, default: () => ({ enabled: false }) }
  },

  /** One-off unavailable blocks (overrides weekly availability). */
  timeOff: { type: [timeOffSchema], default: [] },

  /** Optional link to an app User (if the provider logs in). */
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  /** Google Calendar 2-way sync state (Phase 5). */
  google: {
    connected: { type: Boolean, default: false },
    calendarId: { type: String, trim: true, default: 'primary' },
    accessToken: { type: String },
    refreshToken: { type: String },
    tokenExpiry: { type: Date },
    channelId: { type: String, trim: true },   // events.watch channel id
    resourceId: { type: String, trim: true },  // events.watch resource id
    watchExpiry: { type: Date },
    syncToken: { type: String, trim: true }
  },

  isActive: { type: Boolean, default: true, index: true }
}, {
  timestamps: true
});

providerSchema.index({ organization: 1, isActive: 1, name: 1 });
providerSchema.index({ organization: 1, services: 1 });

module.exports = mongoose.model('Provider', providerSchema);
