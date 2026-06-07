const express = require('express');
const router = express.Router();
const knowledgeBaseController = require('../controllers/knowledgeBaseController');
const { protect } = require('../middlewares/auth');
const { validateKnowledgeBaseManual, validateKnowledgeBaseUpdate } = require('../middlewares/validation');

// All routes require authentication
router.use(protect);

// Get all knowledge base entries
router.get('/', knowledgeBaseController.getAllKnowledgeBase);

// Lightweight existence check (used by inbox setup guide)
router.get('/exists', knowledgeBaseController.knowledgeBaseExists);

// Get categories
router.get('/categories', knowledgeBaseController.getCategories);

// Poll website-crawl status — MUST be registered before '/:id' so the literal
// '/url' segment isn't captured as an :id.
router.get('/url/crawl/:jobId', knowledgeBaseController.getCrawlStatus);

// Get single knowledge base entry
router.get('/:id', knowledgeBaseController.getKnowledgeBaseById);

// Create manual knowledge base entry
router.post('/manual', validateKnowledgeBaseManual, knowledgeBaseController.createManualKnowledgeBase);

// Create knowledge base from PDF
router.post('/pdf', knowledgeBaseController.upload.single('file'), knowledgeBaseController.createPDFKnowledgeBase);

// Create knowledge base from a single URL (homepage only)
router.post('/url', knowledgeBaseController.createURLKnowledgeBase);

// Create knowledge base by crawling the ENTIRE website (internal pages)
router.post('/url/crawl', knowledgeBaseController.createCrawlKnowledgeBase);

// Update knowledge base entry
router.put('/:id', validateKnowledgeBaseUpdate, knowledgeBaseController.updateKnowledgeBase);

// Delete knowledge base entry
router.delete('/:id', knowledgeBaseController.deleteKnowledgeBase);

module.exports = router;

