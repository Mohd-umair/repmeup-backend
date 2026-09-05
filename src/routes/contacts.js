const express = require('express');
const router = express.Router();
const { protect, authorize, requirePermission } = require('../middlewares/auth');
const { contactImportLimiter, duplicateScanLimiter } = require('../middlewares/contactRateLimit');
const {
  getContacts,
  getContact,
  updateContact,
  deleteContact,
  mergeContact,
  toggleFlowOptOut
} = require('../controllers/contactController');
const crm = require('../controllers/contactCrmController');

router.use(protect);

router.get('/', authorize('admin', 'manager', 'agent'), requirePermission('contacts.read'), crm.listContacts);
router.post('/filter-preview', authorize('admin', 'manager', 'agent'), requirePermission('contacts.read'), crm.filterPreview);
router.get('/tags', authorize('admin', 'manager', 'agent'), requirePermission('contacts.read'), crm.listTags);
router.get('/owners', authorize('admin', 'manager', 'agent'), requirePermission('contacts.read'), crm.listOwners);
router.get('/teams', authorize('admin', 'manager', 'agent'), requirePermission('contacts.read'), crm.listTeams);
router.post('/teams', authorize('admin', 'manager'), requirePermission('contacts.update'), crm.createTeam);
router.get('/saved-views', authorize('admin', 'manager', 'agent'), requirePermission('contacts.read'), crm.listPresets);
router.post('/saved-views', authorize('admin', 'manager'), requirePermission('segments.manage'), crm.createPreset);
router.put('/saved-views/:id', authorize('admin', 'manager'), requirePermission('segments.manage'), crm.updatePreset);
router.delete('/saved-views/:id', authorize('admin', 'manager'), requirePermission('segments.manage'), crm.deletePreset);
router.post('/saved-views/seed', authorize('admin', 'manager'), requirePermission('contacts.read'), crm.seedSystemViews);
router.post('/bulk', authorize('admin', 'manager'), requirePermission('contacts.bulk_actions'), crm.bulkAction);
router.post('/campaign-audience', authorize('admin', 'manager'), requirePermission('contacts.read'), crm.resolveCampaignAudience);
router.get('/export', authorize('admin', 'manager'), requirePermission('contacts.export'), crm.exportContacts);
router.post('/import', authorize('admin', 'manager'), requirePermission('contacts.import'), contactImportLimiter, crm.importContacts);
router.get('/custom-fields', authorize('admin', 'manager', 'agent'), requirePermission('contacts.read'), crm.listCustomFields);
router.post('/custom-fields', authorize('admin', 'manager'), requirePermission('customfields.manage'), crm.createCustomField);
router.put('/custom-fields/:id', authorize('admin', 'manager'), requirePermission('customfields.manage'), crm.updateCustomField);
router.delete('/custom-fields/:id', authorize('admin', 'manager'), requirePermission('customfields.manage'), crm.deleteCustomField);
router.get('/duplicates', authorize('admin', 'manager'), requirePermission('contacts.merge'), crm.listDuplicates);
router.post('/duplicates/scan', authorize('admin', 'manager'), requirePermission('contacts.merge'), duplicateScanLimiter, crm.scanDuplicates);
router.post('/duplicates/:id/dismiss', authorize('admin', 'manager'), requirePermission('contacts.merge'), crm.dismissDuplicate);

router.get('/:id/notes', authorize('admin', 'manager', 'agent'), requirePermission('contacts.read'), crm.listNotes);
router.post('/:id/notes', authorize('admin', 'manager'), requirePermission('contacts.update'), crm.addNote);
router.get('/:id/tasks', authorize('admin', 'manager', 'agent'), requirePermission('contacts.read'), crm.listTasks);
router.post('/:id/tasks', authorize('admin', 'manager'), requirePermission('contacts.update'), crm.addTask);
router.put('/:id/tasks/:taskId', authorize('admin', 'manager'), requirePermission('contacts.update'), crm.updateTask);
router.get('/:id/activity', authorize('admin', 'manager', 'agent'), requirePermission('contacts.read'), crm.listActivity);
router.get('/:id/orders', authorize('admin', 'manager', 'agent'), requirePermission('contacts.read'), crm.listOrders);
router.post('/:id/intelligence', authorize('admin', 'manager'), requirePermission('contacts.update'), crm.recomputeIntelligence);
router.post('/:id/summary', authorize('admin', 'manager'), requirePermission('contacts.update'), crm.generateSummary);
router.post('/:id/merge-id', authorize('admin', 'manager'), requirePermission('contacts.merge'), crm.mergeById);

router.get('/:id', authorize('admin', 'manager', 'agent'), requirePermission('contacts.read'), getContact);
router.put('/:id', authorize('admin', 'manager'), requirePermission('contacts.update'), crm.updateContact);
router.delete('/:id', authorize('admin', 'manager'), requirePermission('contacts.delete'), deleteContact);
router.post('/:id/merge', authorize('admin', 'manager'), requirePermission('contacts.merge'), mergeContact);
router.patch('/:id/flow-opt-out', authorize('admin', 'manager'), requirePermission('contacts.update'), toggleFlowOptOut);

module.exports = router;
