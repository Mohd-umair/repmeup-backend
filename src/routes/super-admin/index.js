/**
 * Super Admin API — isolated under /api/super-admin
 * Requires JWT + role super_admin or admin (panel operators).
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../../middlewares/auth');
const { requireSuperAdminAccess } = require('../../middlewares/superAdminAccess');
const superAdminController = require('../../controllers/superAdminController');
const superAdminMenuController = require('../../controllers/superAdminMenuController');
const gpController = require('../../controllers/groupPermissionController');

router.use(protect);
router.use(requireSuperAdminAccess);

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

router.get('/plans', superAdminController.listPlans);
router.get('/dashboard/stats', superAdminController.getDashboardStats);
router.get('/organizations', superAdminController.listOrganizations);
router.post(
  '/organizations/:organizationId/users',
  superAdminController.createOrganizationUser
);
router.get('/organizations/:id', superAdminController.getOrganization);
router.get('/users', superAdminController.listUsers);
router.get('/users/:id/activity', superAdminController.getUserActivity);
router.get('/users/:id', superAdminController.getUser);
router.patch('/users/:id/status', superAdminController.setUserActive);
router.delete('/users/:id', superAdminController.softDeleteUser);

module.exports = router;
