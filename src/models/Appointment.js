'use strict';

const mongoose = require('mongoose');

/**
 * Appointment — an omnichannel scheduled booking, the appointment-world analogue
 * of CommerceOrder. Created via flows, the AI booking agent, or manually, across
 * Instagram / WhatsApp / Voice / Manual channels.
 *
 * Times are stored as UTC instants (startAt/endAt); `timezone` records the tz the
 * customer/provider booked in for correct display. Service/Provider details are
 * snapshotted so the record stays accurate even if the catalog later changes.
 */

/** Append-only audit of every status change (powers the appointment timeline). */
const statusEventSchema = new mongoose.Schema({
  status: { type: String, trim: true },
  at: { type: Date, default: Date.now },
  note: { type: String, trim: true },
  byName: { type: String, trim: true }
}, { _id: false });

/** Log of reminders already sent so a restart-safe scan never double-sends. */
const reminderSchema = new mongoose.Schema({
  offsetMin: { type: Number },   // how long before startAt this reminder targets
  sentAt: { type: Date },
  channel: { type: String, trim: true }
}, { _id: false });

const appointmentSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },

  // ── Channel ────────────────────────────────────────────────────────────────
  channel: {
    type: String,
    enum: ['instagram', 'whatsapp', 'voice', 'manual'],
    required: true,
    index: true
  },

  // ── Status lifecycle ───────────────────────────────────────────────────────
  /**
   *   requested    → slot held, awaiting business confirmation
   *   confirmed    → confirmed (the active, upcoming state)
   *   completed    → service delivered
   *   cancelled    → cancelled by customer or business (reason captured)
   *   no_show      → customer didn't turn up (auto after grace, or manual)
   *   rescheduled  → moved; a new/updated appointment carries the active slot
   */
  status: {
    type: String,
    enum: ['requested', 'confirmed', 'completed', 'cancelled', 'no_show', 'rescheduled'],
    default: 'requested',
    index: true
  },

  // ── What & who ───────────────────────────────────────────────────────────
  service: { type: mongoose.Schema.Types.ObjectId, ref: 'Service' },
  serviceSnapshot: {
    name: { type: String, trim: true },
    durationMin: { type: Number },
    price: { type: Number },
    currency: { type: String, trim: true }
  },
  provider: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider' },
  providerSnapshot: {
    name: { type: String, trim: true }
  },

  // ── When ───────────────────────────────────────────────────────────────────
  startAt: { type: Date, required: true, index: true }, // UTC instant
  endAt: { type: Date, required: true },                // UTC instant
  timezone: { type: String, default: 'Asia/Kolkata', trim: true },

  // ── Customer ───────────────────────────────────────────────────────────────
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  customerName: { type: String, trim: true },
  customerPhone: { type: String, trim: true },
  instagramUserId: { type: String, trim: true },

  // ── Source references ──────────────────────────────────────────────────────
  sourceInteraction: { type: mongoose.Schema.Types.ObjectId, ref: 'Interaction' },
  sourcePostId: { type: String, trim: true },

  // ── Payment / deposit (optional) ───────────────────────────────────────────
  payment: {
    required: { type: Boolean, default: false },
    amount: { type: Number, min: 0 },
    currency: { type: String, trim: true },
    ref: { type: String, trim: true },
    method: { type: String, trim: true },
    paidAt: { type: Date }
  },

  // ── Reminders / no-show ────────────────────────────────────────────────────
  reminders: { type: [reminderSchema], default: [] },

  // ── Lifecycle timestamps ───────────────────────────────────────────────────
  confirmedAt: { type: Date },
  completedAt: { type: Date },
  cancelledAt: { type: Date },
  noShowAt: { type: Date },
  cancellationReason: { type: String, trim: true },

  /** Link to the prior appointment when this one is a reschedule. */
  rescheduledFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },

  // ── Google Calendar sync ───────────────────────────────────────────────────
  googleEventId: { type: String, trim: true },

  // ── Audit + meta ───────────────────────────────────────────────────────────
  statusHistory: { type: [statusEventSchema], default: [] },
  notes: { type: String, trim: true },

  /** Human-readable ref for ops (e.g. APT-128). */
  appointmentNumber: { type: Number, index: true },
  displayRef: { type: String, trim: true, index: true }
}, {
  timestamps: true
});

// Common query indexes
appointmentSchema.index({ organization: 1, status: 1, startAt: 1 });
appointmentSchema.index({ organization: 1, channel: 1, startAt: -1 });
appointmentSchema.index({ organization: 1, contact: 1 });
appointmentSchema.index({ organization: 1, displayRef: 1 }, { unique: true, sparse: true });

/**
 * Double-booking guard: at most one *active* appointment per provider+startAt.
 * Partial index so cancelled/no_show/rescheduled records don't block the slot.
 */
appointmentSchema.index(
  { organization: 1, provider: 1, startAt: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['requested', 'confirmed'] } }
  }
);

module.exports = mongoose.model('Appointment', appointmentSchema);
