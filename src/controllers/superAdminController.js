const superAdminService = require('../services/superAdminService');
const Transaction = require('../models/Transaction');
const aiUsageReportService = require('../services/aiUsageReportService');

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

/**
 * GET /api/super-admin/ai-usage
 * Query: organizationId, feature, apiKind, startDate, endDate, groupBy=feature|organization|day|feature_org
 * format=json|csv — CSV returns raw rows (capped)
 */
exports.getAiUsage = async (req, res, next) => {
  try {
    if (req.query.format === 'csv') {
      const raw = await aiUsageReportService.listRaw(req.query);
      const csv = aiUsageReportService.toCsv(raw);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="ai-api-usage.csv"');
      return res.status(200).send(csv);
    }
    const data = await aiUsageReportService.aggregateReport(req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/super-admin/transactions
 * Query params:
 *   type    — filter by transaction type: order | payment | renewal | failed
 *   status  — filter by status: pending | completed | failed
 *   search  — partial match on organizationName (case-insensitive)
 *   page    — page number (default 1)
 *   limit   — page size (default 50, max 100)
 */
exports.listTransactions = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.type)   filter.type   = req.query.type;
    // Payments tab: exclude 'order' type so only payment/renewal/failed events are shown
    if (req.query.excludeOrders === 'true') filter.type = { $ne: 'order' };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.search) {
      filter.organizationName = { $regex: req.query.search, $options: 'i' };
    }

    const [items, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('organization', 'name slug')
        .populate('user', 'firstName lastName email')
        .lean(),
      Transaction.countDocuments(filter)
    ]);

    res.status(200).json({
      success: true,
      data: {
        items,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    next(error);
  }
};
