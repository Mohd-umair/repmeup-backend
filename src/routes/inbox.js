const express = require('express');
const router = express.Router();
const inboxController = require('../controllers/inboxController');
const { protect, authorize } = require('../middlewares/auth');
const { validateReply } = require('../middlewares/validation');

// All inbox routes require authentication
router.use(protect);

// Get inbox stats
router.get('/stats', inboxController.getStats);

// Get all interactions
router.get('/', inboxController.getInteractions);

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

module.exports = router;

