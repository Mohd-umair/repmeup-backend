const express = require('express');
const router = express.Router();
const inboxController = require('../controllers/inboxController');
const { protect, authorize } = require('../middlewares/auth');
const { validateReply } = require('../middlewares/validation');

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

// Get author avatar (must be before /:id)
// Avatar proxy endpoint removed - no longer needed (avatars are stored in interaction.author.avatarUrl)
// router.get('/avatar/:platform/:userId', inboxController.getAuthorAvatar);

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
  inboxController.assignInteraction
);

// Add label to interaction
router.put('/:id/labels', inboxController.addLabel);

// Add internal note
router.post('/:id/notes', inboxController.addNote);

// Update status
router.put('/:id/status', inboxController.updateStatus);


// Bulk assign interactions (Manager/Admin only)
router.post(
  '/assign-bulk',
  authorize('admin', 'manager'),
  inboxController.bulkAssignInteractions
);

// Bulk update status
router.post('/status-bulk', inboxController.bulkUpdateStatus);

// Bulk add label
router.post('/labels-bulk', inboxController.bulkAddLabel);


// Manually escalate interaction to human agent
router.post('/:id/escalate', inboxController.escalateInteractionManually);

module.exports = router;

