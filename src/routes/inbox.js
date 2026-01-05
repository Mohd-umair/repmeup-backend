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

