const express = require('express');
const router = express.Router();
const knowledgeBaseController = require('../controllers/knowledgeBaseController');
const { protect } = require('../middlewares/auth');

// All routes require authentication
router.use(protect);

// Get all knowledge base entries
router.get('/', knowledgeBaseController.getAllKnowledgeBase);

// Get categories
router.get('/categories', knowledgeBaseController.getCategories);

// Get single knowledge base entry
router.get('/:id', knowledgeBaseController.getKnowledgeBaseById);

// Create manual knowledge base entry
router.post('/manual', knowledgeBaseController.createManualKnowledgeBase);

// Create knowledge base from PDF
router.post('/pdf', knowledgeBaseController.upload.single('file'), knowledgeBaseController.createPDFKnowledgeBase);

// Create knowledge base from URL
router.post('/url', knowledgeBaseController.createURLKnowledgeBase);

// Update knowledge base entry
router.put('/:id', knowledgeBaseController.updateKnowledgeBase);

// Delete knowledge base entry
router.delete('/:id', knowledgeBaseController.deleteKnowledgeBase);

module.exports = router;

