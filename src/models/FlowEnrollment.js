const mongoose = require('mongoose');

const historyEntrySchema = new mongoose.Schema({
  nodeId: { type: String, required: true },
  event: { type: String, trim: true, default: '' },
  at: { type: Date, default: Date.now }
}, { _id: false });

const flowEnrollmentSchema = new mongoose.Schema({
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  flow: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AutomationFlow',
    required: true,
    index: true
  },
  flowVersion: { type: Number, default: 1 },
  platform: {
    type: String,
    enum: ['whatsapp', 'instagram', 'facebook'],
    required: true,
    index: true
  },
  platformUserId: { type: String, trim: true, index: true },
  // The wamid (or platform-equivalent message id) of the specific inbound message that
  // started this enrollment. Lets us atomically upsert-guard enrollment creation so the
  // exact same triggering message can never spin up two enrollments for the same flow +
  // contact, even under concurrent/retried webhook processing. Absent for non-message
  // triggers (e.g. appointment reminders) — the partial unique index below only applies
  // when this is a real string.
  triggerMid: { type: String, trim: true, index: true },
  contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  interaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Interaction' },
  currentNodeId: { type: String, trim: true, default: '' },
  variables: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: {
    type: String,
    enum: ['active', 'waiting', 'completed', 'failed', 'dropped'],
    default: 'active',
    index: true
  },
  nextRunAt: { type: Date, index: true },
  lastError: { type: String, trim: true, default: '' },
  history: { type: [historyEntrySchema], default: [] }
}, { timestamps: true });

flowEnrollmentSchema.index({ organization: 1, status: 1, nextRunAt: 1 });
flowEnrollmentSchema.index({ flow: 1, platformUserId: 1, status: 1 });

// Hard, database-level guarantee (not just app-level check-then-create) that the same
// inbound message can never create two enrollments for the same flow + contact. Partial
// so it only applies to documents that actually have a triggerMid — legacy rows and
// non-message triggers (no mid) are unaffected.
flowEnrollmentSchema.index(
  { flow: 1, platformUserId: 1, triggerMid: 1 },
  { unique: true, partialFilterExpression: { triggerMid: { $type: 'string' } } }
);

module.exports = mongoose.model('FlowEnrollment', flowEnrollmentSchema);
