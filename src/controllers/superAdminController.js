const superAdminService = require('../services/superAdminService');

/**
 * GET /api/super-admin/plans
 */
exports.listPlans = async (req, res, next) => {
  try {
    const data = await superAdminService.listPlans();
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/super-admin/dashboard/stats
 */
exports.getDashboardStats = async (req, res, next) => {
  try {
    const data = await superAdminService.getDashboardStats();
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/super-admin/organizations
 */
exports.listOrganizations = async (req, res, next) => {
  try {
    const data = await superAdminService.listOrganizations(req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/super-admin/organizations/:id
 */
exports.getOrganization = async (req, res, next) => {
  try {
    const data = await superAdminService.getOrganizationById(req.params.id);
    res.status(200).json({ success: true, data });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message
      });
    }
    next(error);
  }
};

/**
 * POST /api/super-admin/organizations/:organizationId/users
 * Body: { email, password, firstName, lastName, role? }
 */
exports.createOrganizationUser = async (req, res, next) => {
  try {
    const data = await superAdminService.createUserForOrganization(
      req.params.organizationId,
      req.body
    );
    res.status(201).json({
      success: true,
      data,
      message: 'User created successfully'
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message
      });
    }
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({
        success: false,
        error: messages.join(', ')
      });
    }
    next(error);
  }
};

/**
 * GET /api/super-admin/users
 */
exports.listUsers = async (req, res, next) => {
  try {
    const data = await superAdminService.listUsers(req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message
      });
    }
    next(error);
  }
};

/**
 * GET /api/super-admin/users/:id/activity
 */
exports.getUserActivity = async (req, res, next) => {
  try {
    const data = await superAdminService.listUserActivity(req.params.id, req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message
      });
    }
    next(error);
  }
};

/**
 * GET /api/super-admin/users/:id
 */
exports.getUser = async (req, res, next) => {
  try {
    const data = await superAdminService.getUserDetailById(req.params.id, req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message
      });
    }
    next(error);
  }
};

/**
 * PATCH /api/super-admin/users/:id/status
 * Body: { "isActive": true | false } — reactivating clears soft-delete (deletedAt).
 */
exports.setUserActive = async (req, res, next) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'Body must include isActive (boolean)'
      });
    }
    const data = await superAdminService.setUserActive(req.user._id, req.params.id, isActive);
    res.status(200).json({
      success: true,
      data,
      message: isActive ? 'User activated' : 'User deactivated'
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message
      });
    }
    next(error);
  }
};

/**
 * DELETE /api/super-admin/users/:id — soft delete (sets deletedAt, isActive false).
 */
exports.softDeleteUser = async (req, res, next) => {
  try {
    const data = await superAdminService.softDeleteUser(req.user._id, req.params.id);
    res.status(200).json({
      success: true,
      data,
      message: 'User removed (soft delete)'
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message
      });
    }
    next(error);
  }
};
