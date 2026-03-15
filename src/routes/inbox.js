const express = require('express');
const router = express.Router();
const inboxController = require('../controllers/inboxController');
const { protect, authorize } = require('../middlewares/auth');
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

// Get inbox stats (must be before /:id)
router.get('/stats', inboxController.getStats);

// Get org labels (must be before /:id)
router.get('/labels', inboxController.getLabels);

// Get available agents for assignment (Manager/Admin only) (must be before /:id)
router.get(
  '/agents',
  authorize('admin', 'manager'),
  inboxController.getAvailableAgents
);

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

// Get single interaction
router.get('/:id', inboxController.getInteraction);

// Reply to interaction
router.post('/:id/reply', validateReply, inboxController.replyToInteraction);

// Generate AI suggested reply for interaction
router.post('/:id/suggest-reply', inboxController.suggestReply);

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

// Assign interaction (Manager/Admin only)
router.put(
  '/:id/assign',
  authorize('admin', 'manager'),
  validateInboxAssign,
  inboxController.assignInteraction
);

// Add label to interaction
router.put('/:id/labels', validateInboxAddLabel, inboxController.addLabel);

// Add internal note
router.post('/:id/notes', validateInboxAddNote, inboxController.addNote);

// Update status
router.put('/:id/status', validateInboxUpdateStatus, inboxController.updateStatus);

// Delete interaction (Facebook comment: deletes on Facebook and in DB; others: DB only)
router.delete('/:id', inboxController.deleteInteraction);


// Bulk assign interactions (Manager/Admin only)
router.post(
  '/assign-bulk',
  authorize('admin', 'manager'),
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

module.exports = router;

