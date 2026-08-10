/**
 * Super Admin API — isolated under /api/super-admin
 * Requires a token issued by POST /api/auth/admin-login (signed with
 * SUPER_ADMIN_JWT_SECRET) + role super_admin.
 *
 * Two-layer gate:
 *   1. protectAdmin — verify admin-issued JWT (SUPER_ADMIN_JWT_SECRET)
 *   2. requireSuperAdminAccess — double-check role on the loaded User document
 */
const express = require('express');
const router = express.Router();
const { protectAdmin } = require('../../middlewares/adminAuth');
const { requireSuperAdminAccess } = require('../../middlewares/superAdminAccess');
const superAdminController = require('../../controllers/superAdminController');
const superAdminMenuController = require('../../controllers/superAdminMenuController');
const contactInquiryController = require('../../controllers/contactInquiryController');
const gpController = require('../../controllers/groupPermissionController');
const ticketController = require('../../controllers/ticketController');
const superAdminFaqController = require('../../controllers/superAdminFaqController');
const inspirationAdminController = require('../../controllers/inspirationAdminController');
const featureController = require('../../controllers/featureController');
const multer = require('multer');

// ── Authentication gates ─────────────────────────────────────────────────────
router.use(protectAdmin);            // 1. Verify admin JWT (SUPER_ADMIN_JWT_SECRET)
router.use(requireSuperAdminAccess); // 2. Role double-check on loaded user doc

// Groups & Permissions
router.get('/permissions/meta', gpController.getPermissionMeta);
router.get('/permissions', gpController.listPermissions);
router.post('/permissions', gpController.createPermission);
router.put('/permissions/:id', gpController.updatePermission);
router.delete('/permissions/:id', gpController.deletePermission);

router.get('/groups', gpController.listGroups);
router.post('/groups', gpController.createGroup);
router.get('/groups/:id', gpController.getGroup);
router.put('/groups/:id', gpController.updateGroup);
router.delete('/groups/:id', gpController.deleteGroup);

router.patch('/users/:userId/group', gpController.assignGroupToUser);
router.post('/seed/permissions', gpController.seedPermissions);

router.get('/menus', superAdminMenuController.listAllMenus);
router.get('/menus/parent-options', superAdminMenuController.listTopLevelParentOptions);
router.post('/menus', superAdminMenuController.createMenu);
router.put('/menus/:id', superAdminMenuController.updateMenu);
router.delete('/menus/:id', superAdminMenuController.deleteMenu);
router.post('/menus/bootstrap-defaults', superAdminMenuController.bootstrapDefaultSubmenus);

router.get('/faqs', superAdminFaqController.listFaqs);
router.put('/faqs', superAdminFaqController.syncFaqs);
router.post('/faqs/seed-defaults', superAdminFaqController.seedDefaults);

const superAdminCampaignMetricsController = require('../../controllers/superAdminCampaignMetricsController');
router.get('/campaign-metrics', superAdminCampaignMetricsController.getCampaignMetrics);
router.patch(
  '/platform-connections/:id/waba-metadata',
  superAdminCampaignMetricsController.updateWabaMetadata
);

// Support tickets
router.get('/tickets', ticketController.superAdminListTickets);
router.patch('/tickets/:id/status', ticketController.superAdminUpdateStatus);

// Lead Management CRM
router.use('/crm', require('./crm'));

router.get('/plans', superAdminController.listPlans);
router.get('/features', featureController.listCatalog);
router.get('/contact-inquiries', contactInquiryController.listForSuperAdmin);
router.get('/transactions', superAdminController.listTransactions);
router.get('/dashboard/stats', superAdminController.getDashboardStats);
router.get('/ai-usage/records/:id', superAdminController.getAiUsageRecordById);
router.get('/ai-usage/records', superAdminController.getAiUsageRecords);
router.get('/ai-usage', superAdminController.getAiUsage);
router.get('/organizations', superAdminController.listOrganizations);

// Demo / Trial workspaces — one-click create a full-featured demo for a prospect.
router.post('/demo-workspaces', superAdminController.createDemoWorkspace);
router.get('/demo-workspaces', superAdminController.listDemoWorkspaces);
router.patch('/demo-workspaces/:organizationId', superAdminController.updateDemoWorkspace);
router.post('/demo-workspaces/:organizationId/extend', superAdminController.extendDemoTrial);
router.post('/demo-workspaces/:organizationId/convert', superAdminController.convertDemoWorkspace);

router.post(
  '/organizations/:organizationId/users',
  superAdminController.createOrganizationUser
);
router.post(
  '/organizations/:id/impersonate',
  superAdminController.impersonateOrganization
);
router.get('/organizations/:id', superAdminController.getOrganization);
router.get('/users', superAdminController.listUsers);
router.get('/users/:id/activity', superAdminController.getUserActivity);
router.get('/users/:id/password', superAdminController.getUserPassword);
router.post('/users/:id/impersonate', superAdminController.impersonateUser);
router.post('/users/:id/reset-password', superAdminController.resetUserPassword);
router.get('/users/:id', superAdminController.getUser);
router.patch('/users/:id/status', superAdminController.setUserActive);
router.delete('/users/:id', superAdminController.softDeleteUser);

// Inspiration Library management
const inspirationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 25 }
});
router.get('/inspirations', inspirationAdminController.list);
router.post('/inspirations', inspirationUpload.array('images', 25), inspirationAdminController.create);
router.patch('/inspirations/:id', inspirationAdminController.update);
router.delete('/inspirations/:id', inspirationAdminController.remove);

module.exports = router;
