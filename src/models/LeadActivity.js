const mongoose = require('mongoose');

/**
 * LeadActivity — timeline entry for a Lead.
 *
 * User-created: note, call, email, meeting, task (isTask + dueAt).
 * System-generated: status_change ({from, to, durationMs}), assignment
 * ({fromUserId, toUserId}), system (creation / auto-capture, records
 * meta.initialStatus which powers the reached-stage funnel).
 *
 * Hard records — no soft delete. Queries are always scoped through the
 * parent lead, so activities of soft-deleted leads are naturally excluded.
 */

const ACTIVITY_TYPES = [
  'note',
  'call',
  'email',
  'meeting',
  'status_change',
  'assignment',
  'task',
  'system'
];

/** Subset creatable via the API (the rest are service-generated) */
const USER_ACTIVITY_TYPES = ['note', 'call', 'email', 'meeting', 'task'];

const leadActivitySchema = new mongoose.Schema(
  {
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    body: { type: String, trim: true, maxlength: 5000, default: '' },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },

    isTask: { type: Boolean, default: false },
    dueAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    /** null = system-generated */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

// Timeline pagination
leadActivitySchema.index({ lead: 1, createdAt: -1 });
// Per-lead open tasks
leadActivitySchema.index({ lead: 1, isTask: 1, completedAt: 1, dueAt: 1 });
// Global due/overdue task feed + overdue count
leadActivitySchema.index(
  { dueAt: 1 },
  { partialFilterExpression: { isTask: true, completedAt: null } }
);
// Time-in-stage aggregation
leadActivitySchema.index({ type: 1, 'meta.from': 1 });

const LeadActivity = mongoose.model('LeadActivity', leadActivitySchema);

LeadActivity.ACTIVITY_TYPES = ACTIVITY_TYPES;
LeadActivity.USER_ACTIVITY_TYPES = USER_ACTIVITY_TYPES;

module.exports = LeadActivity;
