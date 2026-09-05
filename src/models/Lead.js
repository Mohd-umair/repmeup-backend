const mongoose = require('mongoose');

/**
 * Lead — platform-level CRM lead (super-admin scope, not tenant-scoped).
 *
 * Sources: public website contact form (ContactInquiry), demo bookings
 * (ContactInquiry with intent 'book-demo'), growth-audit lead captures
 * (GrowthAudit.lead), or manual entry from the admin panel.
 *
 * `status` doubles as the Kanban pipeline stage. Every status change is
 * recorded as a LeadActivity (type 'status_change') by leadService.
 */

const LEAD_STATUSES = [
  'new',
  'contacted',
  'qualified',
  'demo_scheduled',
  'proposal',
  'won',
  'lost'
];

const LEAD_SOURCES = ['website_contact', 'demo_booking', 'growth_audit', 'manual', 'other'];

const LEAD_PRIORITIES = ['low', 'medium', 'high'];

const CAPTURE_KINDS = ['ContactInquiry', 'GrowthAudit', 'manual'];

const leadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    // Not unique: dedup is service-level (soft-deleted leads would break a unique index)
    email: { type: String, lowercase: true, trim: true, maxlength: 320, default: '' },
    phone: { type: String, trim: true, maxlength: 40, default: '' },
    company: { type: String, trim: true, maxlength: 200, default: '' },

    status: { type: String, enum: LEAD_STATUSES, default: 'new' },
    source: { type: String, enum: LEAD_SOURCES, required: true },
    priority: { type: String, enum: LEAD_PRIORITIES, default: 'medium' },
    estimatedValue: { type: Number, default: 0, min: 0 },
    tags: [{ type: String, trim: true, lowercase: true, maxlength: 50 }],
    lostReason: { type: String, trim: true, maxlength: 500, default: '' },

    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** null = auto-captured (no acting user) */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    convertedToOrganization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null
    },

    /** Every inbound touch, including duplicate re-submissions merged into this lead */
    captures: [
      {
        _id: false,
        kind: { type: String, enum: CAPTURE_KINDS, required: true },
        refId: { type: mongoose.Schema.Types.ObjectId, default: null },
        source: { type: String, enum: LEAD_SOURCES, required: true },
        at: { type: Date, default: Date.now }
      }
    ],

    /** Source extras: demoDate/demoTime/timezone, auditScore/auditGrade/revenueLeak, messageExcerpt */
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },

    /** Reset on every status change — powers time-in-stage analytics */
    stageEnteredAt: { type: Date, default: Date.now },
    lastActivityAt: { type: Date, default: Date.now },
    /** Denormalized earliest open task dueAt — maintained by leadService */
    nextFollowUpAt: { type: Date, default: null },

    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// List default sort + kanban grouping
leadSchema.index({ isDeleted: 1, status: 1, createdAt: -1 });
// Assignee filter ("my leads")
leadSchema.index({ isDeleted: 1, assignedTo: 1, status: 1 });
// Source filter + analytics time-series
leadSchema.index({ isDeleted: 1, source: 1, createdAt: -1 });
// Overdue follow-up sort/filter
leadSchema.index({ isDeleted: 1, nextFollowUpAt: 1 });
// Dedup lookups on capture
leadSchema.index({ email: 1 });
leadSchema.index({ phone: 1 }, { sparse: true });
// "Recently touched" sort (board)
leadSchema.index({ lastActivityAt: -1 });
leadSchema.index({ tags: 1 }, { sparse: true });

const Lead = mongoose.model('Lead', leadSchema);

Lead.LEAD_STATUSES = LEAD_STATUSES;
Lead.LEAD_SOURCES = LEAD_SOURCES;
Lead.LEAD_PRIORITIES = LEAD_PRIORITIES;

module.exports = Lead;
