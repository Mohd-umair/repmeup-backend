const superAdminService = require('../services/superAdminService');
const Transaction = require('../models/Transaction');
const aiUsageReportService = require('../services/aiUsageReportService');
const userActivityLogService = require('../services/userActivityLogService');
const demoWorkspaceService = require('../services/demoWorkspaceService');

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
      req.body,
      req.user._id
    );
    const { provisionalPassword, ...userData } = data || {};
    res.status(201).json({
      success: true,
      data: userData,
      message: 'User created successfully',
      provisionalPassword: provisionalPassword || undefined
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
 * GET /api/super-admin/users/:id/password — reveal admin-stored password if available
 */
exports.getUserPassword = async (req, res, next) => {
  try {
    const data = await superAdminService.getUserPasswordReveal(req.params.id);
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
 * POST /api/super-admin/users/:id/reset-password
 * Body: { password? } — optional custom password; otherwise auto-generated
 */
exports.resetUserPassword = async (req, res, next) => {
  try {
    const data = await superAdminService.resetUserPasswordReveal(
      req.user._id,
      req.params.id,
      req.body
    );
    res.status(200).json({
      success: true,
      data,
      message: 'Password reset successfully'
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
 * POST /api/super-admin/users/:id/impersonate — issue short-lived JWT for main app
 */
exports.impersonateUser = async (req, res, next) => {
  try {
    const data = await superAdminService.impersonateUser(req.user._id, req.params.id);
    userActivityLogService.recordAuthEvent({
      userId: req.user._id,
      organizationId: req.user.organization?._id || req.user.organization,
      action: 'super_admin_impersonate_user',
      path: `/api/super-admin/users/${req.params.id}/impersonate`,
      method: 'POST',
      statusCode: 200,
      ip: userActivityLogService.clientIp(req),
      userAgent: req.headers['user-agent'],
      metadata: { targetUserId: req.params.id, targetEmail: data.user?.email }
    });
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
 * POST /api/super-admin/organizations/:id/impersonate — login as org primary admin
 */
exports.impersonateOrganization = async (req, res, next) => {
  try {
    const data = await superAdminService.impersonateOrganization(req.user._id, req.params.id);
    userActivityLogService.recordAuthEvent({
      userId: req.user._id,
      organizationId: req.user.organization?._id || req.user.organization,
      action: 'super_admin_impersonate_org',
      path: `/api/super-admin/organizations/${req.params.id}/impersonate`,
      method: 'POST',
      statusCode: 200,
      ip: userActivityLogService.clientIp(req),
      userAgent: req.headers['user-agent'],
      metadata: {
        organizationId: req.params.id,
        targetUserId: data.user?._id,
        targetEmail: data.user?.email
      }
    });
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
 * GET /api/super-admin/ai-usage/records
 * Same filters as aggregate + page, limit — paginated rows (excludes stored prompts).
 */
exports.getAiUsageRecords = async (req, res, next) => {
  try {
    const data = await aiUsageReportService.listRecords(req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/super-admin/ai-usage/records/:id
 * Single row including promptMessages + completionText where stored.
 */
exports.getAiUsageRecordById = async (req, res, next) => {
  try {
    const row = await aiUsageReportService.getRecordById(req.params.id);
    if (!row) {
      return res.status(404).json({
        success: false,
        error: 'Record not found'
      });
    }
    res.status(200).json({ success: true, data: row });
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

/**
 * POST /api/super-admin/demo-workspaces
 * Create a full-featured demo/trial workspace for a prospect.
 * Body: { prospect: { name, email, company?, phone? }, planId?, trialDays? }
 *
 * Returns login credentials + a magic link the team can share. The workspace is
 * a real tenant; when the prospect purchases, it becomes their production
 * account with no data migration.
 */
exports.createDemoWorkspace = async (req, res, next) => {
  try {
    const { prospect, planId, trialDays, aiCreditsCap } = req.body || {};
    if (!prospect || !prospect.email) {
      return res.status(400).json({ success: false, error: 'prospect.email is required' });
    }

    const result = await demoWorkspaceService.createDemoWorkspace({
      prospect,
      planId,
      trialDays: trialDays != null ? Number(trialDays) : undefined,
      // null/'' → unlimited; a number → cap. Undefined leaves it default (unlimited).
      aiCreditsCap: aiCreditsCap === '' || aiCreditsCap == null ? null : Number(aiCreditsCap),
      actorUserId: req.user._id
    });

    // Build the magic link from the configured frontend URL.
    const base = (process.env.FRONTEND_URL || 'http://localhost:4200').split(',')[0].trim().replace(/\/$/, '');
    const magicLink = `${base}/demo-login?token=${result.magicLinkToken}`;

    res.status(201).json({
      success: true,
      message: 'Demo workspace created successfully',
      data: {
        organizationId: String(result.organization._id),
        organizationName: result.organization.name,
        userId: String(result.user._id),
        loginEmail: result.user.email,
        provisionalPassword: result.provisionalPassword,
        magicLink,
        trialEndsAt: result.trialEndsAt,
        planId: result.subscription.planId,
        planName: result.subscription.planName
      }
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    next(error);
  }
};

/**
 * GET /api/super-admin/demo-workspaces
 * List demo workspaces with live trial status. Query: status?, page?, limit?
 */
exports.listDemoWorkspaces = async (req, res, next) => {
  try {
    const data = await demoWorkspaceService.listDemoWorkspaces(req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    next(error);
  }
};

/**
 * POST /api/super-admin/demo-workspaces/:organizationId/extend
 * Body: { days }. Extends (and unlocks) a demo trial.
 */
exports.extendDemoTrial = async (req, res, next) => {
  try {
    const { days } = req.body || {};
    const result = await demoWorkspaceService.extendTrial(req.params.organizationId, days);
    res.status(200).json({ success: true, data: { trialEndsAt: result.trialEndsAt }, message: 'Trial extended successfully' });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    next(error);
  }
};

/**
 * POST /api/super-admin/demo-workspaces/:organizationId/convert
 * Body: { planId }. Converts the demo to a paid plan IN PLACE (no migration).
 */
exports.convertDemoWorkspace = async (req, res, next) => {
  try {
    const { planId } = req.body || {};
    if (!planId) return res.status(400).json({ success: false, error: 'planId is required' });
    const result = await demoWorkspaceService.convertToPaid(req.params.organizationId, planId, req.user._id);
    res.status(200).json({
      success: true,
      data: { planId: result.subscription.planId, planName: result.subscription.planName, status: result.subscription.status },
      message: 'Demo workspace converted to a paid plan'
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    next(error);
  }
};

/**
 * PATCH /api/super-admin/demo-workspaces/:organizationId
 * Update a demo workspace's prospect details and/or trial length.
 * Body: { name?, email?, company?, phone?, trialDays? }
 * Changing the email also updates the prospect's login email; trialDays resets
 * the trial to end that many days from now (and unlocks it).
 */
exports.updateDemoWorkspace = async (req, res, next) => {
  try {
    const { name, email, company, phone, trialDays, aiCreditsCap } = req.body || {};
    // Only forward keys that were actually provided (partial update).
    const prospect = {};
    if (name !== undefined) prospect.name = name;
    if (email !== undefined) prospect.email = email;
    if (company !== undefined) prospect.company = company;
    if (phone !== undefined) prospect.phone = phone;

    const opts = {};
    if (trialDays !== undefined && trialDays !== null && trialDays !== '') {
      opts.trialDays = Number(trialDays);
    }
    // aiCreditsCap is intentionally forwarded even when '' (=> unlimited) so the
    // admin can clear a cap; only `undefined` means "leave unchanged".
    if (aiCreditsCap !== undefined) {
      opts.aiCreditsCap = aiCreditsCap;
    }

    if (Object.keys(prospect).length === 0 && opts.trialDays === undefined && opts.aiCreditsCap === undefined) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    const result = await demoWorkspaceService.updateDemoProspect(req.params.organizationId, prospect, opts);
    res.status(200).json({
      success: true,
      data: result,
      message: result.loginEmailChanged
        ? 'Prospect updated. Login email changed.'
        : (result.trialEndsAt ? 'Demo workspace updated. Trial period changed.' : 'Prospect details updated')
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    next(error);
  }
};
