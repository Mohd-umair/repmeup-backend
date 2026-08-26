const express = require('express');
const router = express.Router();
const inboxController = require('../controllers/inboxController');
const inboxOpsController = require('../controllers/inboxOpsController');
const { protect, authorize } = require('../middlewares/auth');
const { requireFeature, requireLevel } = require('../middlewares/requireFeature');
const { FEATURE_KEYS } = require('../config/featureCatalog');
const {
  validateReply,
  validateInboxAssign,
  validateInboxAddLabel,
  validateInboxAddNote,
  validateInboxUpdateStatus,
  validateInboxBulkAssign,
  validateInboxBulkStatus,
  validateInboxBulkLabel,
  validateInboxAutoReplyGenerate,
  validateInboxEscalate
} = require('../middlewares/validation');

// All inbox routes require authentication
router.use(protect);


// Get all interactions
router.get('/', inboxController.getInteractions);
// Get interactions grouped by intent bucket (kanban view) — must be before /:id
router.get('/bucket-view', inboxController.getBucketView);
// Get inbox stats (must be before /:id)
router.get('/stats', inboxController.getStats);
// Get topic insights (keyword frequency + recommendation) across all org messages
router.get('/topic-insights', inboxController.getTopicInsights);
// Get org labels (must be before /:id)
router.get('/labels', inboxController.getLabels);
// Get available agents for assignment (Manager/Admin only) (must be before /:id)
router.get( '/agents', authorize('admin', 'manager'), inboxController.getAvailableAgents);
// Get escalated interactions requiring human response (must be before /:id)
router.get('/escalated', inboxController.getEscalatedInteractions);

// Get escalation statistics (Manager/Admin only) (must be before /:id)
router.get(
  '/escalation-stats',
  authorize('admin', 'manager'),
  inboxController.getEscalationStats
);

// Get author avatar (must be before /:id) — proxy for Facebook/Instagram so img loads with token
router.get('/avatar/:platform/:userId', inboxController.getAuthorAvatar);

// Get Facebook DM attachment (FB/IG) — must be before /:id
router.get('/attachment', inboxController.getAttachment);
router.get('/instagram-shared-media', inboxController.getInstagramSharedMedia);
// WhatsApp incoming media (image/audio/video) — proxy with WABA token
router.get('/whatsapp-media', inboxController.getWhatsAppMedia);

// ── Inbox Operations (orders, complaints, reviews) ─────────────────────────
/**
 * Orders ladder (none → basic → full) and complaints ladder (none → basic → advanced).
 *
 * Reads stay open at every rung. An org that drops a tier keeps its order and complaint
 * history visible and can still close what is open; it just cannot create new records
 * or use the higher-tier workflow (shipping updates, complaint assignment/SLA).
 */
const requireOrdersBasic = requireLevel(FEATURE_KEYS.COMMERCE_ORDERS_LEVEL, 'basic');
const requireOrdersFull = requireLevel(FEATURE_KEYS.COMMERCE_ORDERS_LEVEL, 'full');
const requireComplaintsBasic = requireLevel(FEATURE_KEYS.SUPPORT_COMPLAINTS_LEVEL, 'basic');
const requireComplaintsAdvanced = requireLevel(FEATURE_KEYS.SUPPORT_COMPLAINTS_LEVEL, 'advanced');

router.get('/ops/orders', inboxOpsController.listOrders);
router.get('/ops/orders/stats', inboxOpsController.getOrderStats);
router.get('/ops/orders/by-interaction/:interactionId', inboxOpsController.getOrderByInteraction);
router.post('/ops/orders', requireOrdersBasic, inboxOpsController.createOrder);
router.get('/ops/orders/:id', inboxOpsController.getOrderDetail);
router.patch('/ops/orders/:id/status', requireOrdersBasic, inboxOpsController.updateOrderStatus);
router.patch('/ops/orders/:id/shipping', requireOrdersFull, inboxOpsController.updateOrderShipping);

router.get('/ops/complaints', inboxOpsController.listComplaints);
router.get('/ops/complaints/stats', inboxOpsController.getComplaintStats);
// Must be before /:id to avoid param conflict
router.post('/ops/complaints/from-interaction/:interactionId', requireComplaintsBasic, inboxOpsController.createComplaintFromInteraction);
// Manual entry — a complaint with no originating chat (walk-in, phone, offline)
router.post('/ops/complaints/manual', requireComplaintsBasic, inboxOpsController.createManualComplaint);
router.get('/ops/complaints/:id', inboxOpsController.getComplaintDetail);
router.post('/ops/complaints/:id/acknowledge', requireComplaintsBasic, inboxOpsController.acknowledgeComplaint);
router.post('/ops/complaints/:id/assign', requireComplaintsAdvanced, inboxOpsController.assignComplaint);
router.post('/ops/complaints/:id/resolve', requireComplaintsBasic, inboxOpsController.resolveComplaint);
router.post('/ops/complaints/:id/close', inboxOpsController.closeComplaint);

router.get('/ops/reviews', inboxOpsController.listReviews);
router.get('/ops/reviews/stats', inboxOpsController.getReviewStats);
// Must be before /:id to avoid param conflict
router.get('/ops/reviews/by-interaction/:interactionId', inboxOpsController.getReviewByInteraction);
router.post('/ops/reviews', inboxOpsController.createReview);
router.get('/ops/reviews/:id', inboxOpsController.getReviewDetail);
router.post('/ops/reviews/:id/suggest-reply', inboxOpsController.suggestReviewReply);
router.post('/ops/reviews/:id/reply', inboxOpsController.publishReviewReply);

// Get single interaction
router.get('/:id', inboxController.getInteraction);

// Reply to interaction
router.post('/:id/reply', validateReply, inboxController.replyToInteraction);
// Soft-delete a single reply (hidden from chat thread)
router.delete('/:id/replies/:replyId', inboxController.deleteReply);

/**
 * AI message suggestions — a plan capability, gated at every entry point that
 * produces a suggestion for an agent (single suggest, the 3-way assist, regenerate).
 * Replying by hand is never gated.
 */
const requireSuggestions = requireFeature(FEATURE_KEYS.INBOX_MESSAGE_SUGGESTIONS);

// Generate AI suggested reply for interaction
router.post('/:id/suggest-reply', requireSuggestions, inboxController.suggestReply);

// Chat summary: AI-generate (POST) or save manual (PUT)
router.post('/:id/summary/generate', inboxController.generateSummary);
router.put('/:id/summary', inboxController.saveSummary);

// Generate AI-assisted replies (short, detailed, sales)
router.post('/:id/ai-assist', requireSuggestions, inboxController.aiAssist);

// Regenerate a single AI reply type
router.post('/:id/ai-assist/regenerate', requireSuggestions, inboxController.aiAssistRegenerate);

// Generate auto-replies for pending interactions (Admin/Manager only)
router.post(
  '/auto-reply/generate',
  authorize('admin', 'manager'),
  validateInboxAutoReplyGenerate,
  inboxController.generateAutoReplies
);

// Test/Debug endpoint - manually trigger scheduled auto-reply
router.post(
  '/auto-reply/test-trigger',
  authorize('admin', 'manager'),
  inboxController.testAutoReplyTrigger
);

/**
 * Inbox collaboration ladder: labels → shared.
 *
 *   labels — label and work the inbox solo (every tier)
 *   shared — assign work to teammates and leave internal notes
 *
 * Assignment and notes are the team features the sheet sells; labels stay open so a
 * solo operator's inbox keeps working exactly as before.
 */
const requireSharedInbox = requireLevel(FEATURE_KEYS.INBOX_COLLABORATION_LEVEL, 'shared');

// Assign interaction (Manager/Admin only)
router.put(
  '/:id/assign',
  authorize('admin', 'manager'),
  requireSharedInbox,
  validateInboxAssign,
  inboxController.assignInteraction
);

// Add label to interaction
router.put('/:id/labels', validateInboxAddLabel, inboxController.addLabel);

// Add internal note
router.post('/:id/notes', requireSharedInbox, validateInboxAddNote, inboxController.addNote);

// Update status
router.put('/:id/status', validateInboxUpdateStatus, inboxController.updateStatus);

// Chat session open / closed (inbox workflow)
/**
 * `inbox.bucket.chat` — "chat from bucket view". Opening a chat session is the action
 * that gate describes; the bucket board itself stays readable, as every read does.
 * (Currently `true` on every plan, so this gate is inert today — it exists so the
 * catalog value is honest and can be tightened without new code.)
 */
router.put('/:id/chat-open', requireFeature(FEATURE_KEYS.INBOX_BUCKET_CHAT), inboxController.updateChatOpen);

// Update intent bucket (drag-and-drop reclassification)
router.put('/:id/bucket', inboxController.updateBucket);

// Delete interaction (Facebook comment: deletes on Facebook and in DB; others: DB only)
router.delete('/:id', inboxController.deleteInteraction);


// Bulk assign interactions (Manager/Admin only)
router.post(
  '/assign-bulk',
  authorize('admin', 'manager'),
  requireSharedInbox,
  validateInboxBulkAssign,
  inboxController.bulkAssignInteractions
);

// Bulk update status
router.post('/status-bulk', validateInboxBulkStatus, inboxController.bulkUpdateStatus);

// Bulk add label
router.post('/labels-bulk', validateInboxBulkLabel, inboxController.bulkAddLabel);


// Manually escalate interaction to human agent
router.post('/:id/escalate', validateInboxEscalate, inboxController.escalateInteractionManually);

// One-time cleanup: remove legacy per-message Instagram DM duplicates (Admin/Manager only)
router.post(
  '/cleanup/instagram-dm-duplicates',
  authorize('admin', 'manager'),
  async (req, res) => {
    try {
      const Interaction = require('../models/Interaction');
      const org = req.user.organization._id;
      const deleted = await Interaction.deleteMany({
        organization: org,
        platform: 'instagram',
        type: 'dm',
        platformId: { $not: /^dm_/ }
      });
      return res.json({ success: true, deleted: deleted.deletedCount });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// One-time backfill: re-resolves stored `graph.facebook.com/{id}/picture` URLs to real CDN URLs.
// Run once after deploying the avatar fix; safe to call again (skips already-resolved records).
router.post(
  '/backfill-avatars',
  authorize('admin', 'manager'),
  inboxController.backfillFacebookAvatars
);

module.exports = router;

