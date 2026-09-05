const mongoose = require('mongoose');

/**
 * AiConversationWindow — the unit the 2026 pricing sheet bills on.
 *
 * One "AI conversation" is a 24-hour window with a contact. The first AI reply
 * opens a window and costs one credit; every further AI reply to that same
 * contact inside the window is free. This mirrors how Meta bills WhatsApp
 * conversations, which is what customers expect the word to mean.
 *
 * Windows are keyed on (organization, contact) rather than per channel: the
 * codebase's contact model is "1 Contact = 1 Person = multiple channel
 * identities", so someone who DMs on Instagram and then messages on WhatsApp
 * inside 24 hours is one conversation, not two. `channels[]` records which
 * surfaces were touched, so per-channel billing stays possible later.
 */
const aiConversationWindowSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true
    },
    contact: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact',
      required: true
    },

    openedAt: { type: Date, default: Date.now },
    /** openedAt + 24h. Compared against `now` on every reply. */
    expiresAt: { type: Date, required: true },
    /**
     * Present and true only while the window is the live one for this contact.
     * Unset (not set to false) when superseded, so the partial unique index
     * below stays small and a new window can be opened immediately.
     */
    active: { type: Boolean },

    /** AI replies sent inside this window, including the one that opened it. */
    messageCount: { type: Number, default: 1 },
    lastAiReplyAt: { type: Date, default: Date.now },
    /** Channels touched inside this window — reporting only, never billing. */
    channels: [{ type: String, trim: true }],

    /** UTC 'YYYY-MM' at open. Lets us reconcile a month's windows against the bucket. */
    periodMonthKey: { type: String, required: true, trim: true },

    /** Whether opening this window consumed a credit (false when the plan is unlimited). */
    charged: { type: Boolean, default: true }
  },
  { timestamps: true }
);

/**
 * At most ONE open window per (org, contact) — enforced by the database, not by
 * application logic. This is the correctness backbone: without it, two AI replies
 * racing for the same contact both see "no open window" and both charge a credit.
 */
aiConversationWindowSchema.index(
  { organization: 1, contact: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true } }
);

/** Monthly reconciliation: window count vs the consumed bucket. */
aiConversationWindowSchema.index({ organization: 1, periodMonthKey: 1 });

/** Keep 30 days past expiry for reporting/disputes, then drop. */
aiConversationWindowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

module.exports = mongoose.model('AiConversationWindow', aiConversationWindowSchema);
