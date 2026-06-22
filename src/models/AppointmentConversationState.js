'use strict';

const mongoose = require('mongoose');

/**
 * Short-lived conversation state for the AI booking agent — remembers the pending
 * service/slot offer between inbound messages (the appointment analogue of
 * SalesConversationState). One row per (organization, customerKey); auto-expires
 * a day after the last update so stale offers never linger.
 */
const offeredSlotSchema = new mongoose.Schema({
  i: Number,
  startAt: String,        // ISO instant
  providerId: String,
  providerName: String,
  label: String
}, { _id: false });

const appointmentConversationStateSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  /** Customer identity on the channel (WA phone / IG user id). */
  customerKey: { type: String, required: true },
  channel: { type: String, trim: true },

  /** awaiting_service | awaiting_slot | awaiting_reschedule_slot */
  stage: { type: String, trim: true },

  serviceId: { type: String, trim: true },
  serviceName: { type: String, trim: true },
  /** When asking which service: the numbered list offered. */
  services: { type: [{ i: Number, id: String, name: String }], default: undefined },
  /** When asking which slot: the numbered slots offered. */
  slots: { type: [offeredSlotSchema], default: undefined },
  /** For reschedule: the appointment being moved. */
  appointmentId: { type: String, trim: true },

  sourceInteraction: { type: mongoose.Schema.Types.ObjectId, ref: 'Interaction' },

  updatedAt: { type: Date, default: Date.now }
});

appointmentConversationStateSchema.index({ organization: 1, customerKey: 1 }, { unique: true });
// TTL: auto-remove a pending offer 24h after the last touch.
appointmentConversationStateSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model('AppointmentConversationState', appointmentConversationStateSchema);
