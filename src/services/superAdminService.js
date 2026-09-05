/**
 * Super Admin domain logic — cross-tenant reads for the operator panel.
 */
const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const User = require('../models/User');
const Plan = require('../models/Plan');
const UserActivityLog = require('../models/UserActivityLog');
const PlatformConnection = require('../models/PlatformConnection');
const Subscription = require('../models/Subscription');
const {
  encryptAdminPassword,
  decryptAdminPassword
} = require('../utils/adminPasswordCipher');
const {
  generateImpersonationToken,
  generateRefreshToken
} = require('../middlewares/auth');
const crypto = require('crypto');

// Everything the admin Plans form needs to hydrate. Razorpay ids and paise amounts are
// read-only in the UI but must be returned, or the form shows them blank.
const PLAN_ADMIN_SELECT = [
  'planId name description tier price billingCycle limits features entitlements',
  'badge badgeColor highlightColor isActive isPublic displayOrder trialDays',
  'stripePriceId stripeProductId createdAt updatedAt',
  'razorpayPlanId priceInr razorpayPlanIdAnnual priceAnnual priceAnnualInr annualOfferLabel',
  'tagline cardStyle inheritsFromPlanId headlineMetricKeys cardBullets entitlementNotes limitedOffer'
].join(' ');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || DEFAULT_PAGE);
  let limit = parseInt(query.limit, 10) || DEFAULT_LIMIT;
  limit = Math.min(Math.max(1, limit), MAX_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Ignore empty and accidental string "undefined"/"null" from query strings */
function normalizeQueryParam(val) {
  if (val == null) return '';
  const s = String(val).trim();
  if (s === '' || s === 'undefined' || s === 'null') return '';
  return s;
}

class SuperAdminService {
  async getDashboardStats() {
    const notDeleted = { deletedAt: null };
    const [
      organizationsTotal,
      usersTotal,
      usersActive,
      plansActive,
      platformConnectionsActive
    ] = await Promise.all([
      Organization.countDocuments(),
      User.countDocuments(notDeleted),
      User.countDocuments({ ...notDeleted, isActive: true }),
      Plan.countDocuments({ isActive: true }),
      PlatformConnection.countDocuments({ isActive: true })
    ]);

    return {
      organizationsTotal,
      usersTotal,
      usersActive,
      plansActive,
      platformConnectionsActive
    };
  }

  /**
   * All subscription plans (same dataset as GET /api/plans/admin).
   */
  async listPlans() {
    const planAdminService = require('./planAdminService');
    const items = await Plan.find()
      .select(PLAN_ADMIN_SELECT)
      .sort({ displayOrder: 1, tier: 1 })
      .lean();
    const countMap = await planAdminService.getSubscriptionCountMap();
    const withCounts = planAdminService.attachSubscriptionCounts(items, countMap);
    return { items: withCounts };
  }

  async listOrganizations(query) {
    const { page, limit, skip } = parsePagination(query);
    const search = normalizeQueryParam(query.search);

    const filter = {};
    if (search) {
      const safe = escapeRegex(search);
      filter.$or = [
        { name: new RegExp(safe, 'i') },
        { slug: new RegExp(safe, 'i') }
      ];
    }

    const [total, items] = await Promise.all([
      Organization.countDocuments(filter),
      Organization.find(filter)
        .select(
          'name slug subscription.plan subscription.status limits.maxUsers usage.currentUsers createdAt'
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0
      }
    };
  }

  async getOrganizationById(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      const err = new Error('Invalid organization id');
      err.statusCode = 400;
      throw err;
    }

    const org = await Organization.findById(id).lean();
    if (!org) {
      const err = new Error('Organization not found');
      err.statusCode = 404;
      throw err;
    }

    const [userCount, connectionCount, subscription] = await Promise.all([
      User.countDocuments({ organization: id, deletedAt: null }),
      PlatformConnection.countDocuments({ organization: id, isActive: true }),
      Subscription.findOne({ organization: id })
        .select(
          'planId planName tier status billingCycle ' +
          'currentPeriodStart currentPeriodEnd razorpayNextBillingAt ' +
          'cancelAtPeriodEnd cancelledAt cancellationReason ' +
          'planHistory razorpaySubscriptionId'
        )
        .lean()
    ]);

    const subData = subscription
      ? {
          planId: subscription.planId,
          planName: subscription.planName,
          tier: subscription.tier,
          status: subscription.status,
          billingCycle: subscription.billingCycle,
          currentPeriodStart: subscription.currentPeriodStart ?? null,
          currentPeriodEnd: subscription.currentPeriodEnd ?? null,
          razorpayNextBillingAt: subscription.razorpayNextBillingAt ?? null,
          razorpaySubscriptionId: subscription.razorpaySubscriptionId ?? null,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? false,
          cancelledAt: subscription.cancelledAt ?? null,
          cancellationReason: subscription.cancellationReason ?? null,
          planHistory: (subscription.planHistory || []).slice(-10).map(h => ({
            planId: h.planId,
            planName: h.planName,
            changedAt: h.changedAt,
            reason: h.reason || null
          }))
        }
      : null;

    return { ...org, _meta: { userCount, connectionCount, subscription: subData } };
  }

  /**
   * Create a user under an organization (super-admin provisioning).
   * Allowed roles: admin, manager, agent, viewer. Enforces plan user limits (Subscription or Organization).
   */
  async createUserForOrganization(organizationId, body, actorUserId) {
    const Subscription = require('../models/Subscription');
    const oid = String(organizationId);
    if (!mongoose.Types.ObjectId.isValid(oid)) {
      const err = new Error('Invalid organization id');
      err.statusCode = 400;
      throw err;
    }

    const org = await Organization.findById(oid);
    if (!org) {
      const err = new Error('Organization not found');
      err.statusCode = 404;
      throw err;
    }

    const { email, password, firstName, lastName, role } = body || {};
    if (!email || !password || !firstName || !lastName) {
      const err = new Error('email, password, firstName, and lastName are required');
      err.statusCode = 400;
      throw err;
    }
    if (String(password).length < 6) {
      const err = new Error('Password must be at least 6 characters');
      err.statusCode = 400;
      throw err;
    }

    const allowedRoles = ['admin', 'manager', 'agent', 'viewer'];
    const userRole = role && allowedRoles.includes(String(role)) ? String(role) : 'agent';

    const emailNorm = String(email).toLowerCase().trim();
    const existingUser = await User.findOne({ email: emailNorm });
    if (existingUser) {
      const err = new Error('Email already exists');
      err.statusCode = 400;
      throw err;
    }

    const subscription = await Subscription.findOne({ organization: oid });
    const currentUserCount = await User.countDocuments({
      organization: oid,
      isActive: true,
      deletedAt: null
    });

    const maxUsers = subscription
      ? subscription.limits.maxUsers
      : (org.limits?.maxUsers ?? 3);
    const isUnlimited = maxUsers === -1;

    if (!isUnlimited && currentUserCount >= maxUsers) {
      const err = new Error(`User limit reached for this organization (max ${maxUsers}).`);
      err.statusCode = 400;
      throw err;
    }

    const user = await User.create({
      email: emailNorm,
      password: String(password),
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      role: userRole,
      organization: oid,
      isActive: true,
      adminRecoverablePassword: encryptAdminPassword(String(password)),
      adminPasswordSetAt: new Date(),
      adminPasswordSetBy: actorUserId || undefined
    });

    await Organization.findByIdAndUpdate(oid, {
      $inc: { 'usage.currentUsers': 1 }
    });
    if (subscription) {
      await Subscription.findByIdAndUpdate(subscription._id, {
        $inc: { 'usage.activeUsers': 1 }
      });
    }

    return User.findById(user._id)
      .select('-password -emailVerificationToken -passwordResetToken')
      .lean()
      .then((doc) => ({ ...doc, provisionalPassword: String(password) }));
  }

  async listUsers(query) {
    const { page, limit, skip } = parsePagination(query);
    const search = normalizeQueryParam(query.search);
    const organizationId = normalizeQueryParam(query.organizationId);
    const includeDeleted =
      normalizeQueryParam(query.includeDeleted) === '1' ||
      normalizeQueryParam(query.includeDeleted).toLowerCase() === 'true';

    const filter = {};
    if (!includeDeleted) {
      filter.deletedAt = null;
    }
    if (organizationId) {
      if (!mongoose.Types.ObjectId.isValid(organizationId)) {
        const err = new Error('Invalid organizationId');
        err.statusCode = 400;
        throw err;
      }
      filter.organization = organizationId;
    }

    if (search) {
      const safe = escapeRegex(search);
      filter.$or = [
        { email: new RegExp(safe, 'i') },
        { firstName: new RegExp(safe, 'i') },
        { lastName: new RegExp(safe, 'i') }
      ];
    }

    /** Main directory excludes agent-role users; list them under each user’s detail → Agents tab */
    filter.role = { $ne: 'agent' };

    const [total, raw] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select('email firstName lastName role isActive lastLogin createdAt organization deletedAt')
        .populate('organization', 'name slug')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    const items = raw.map((u) => ({
      _id: u._id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      role: u.role,
      isActive: u.isActive,
      isDeleted: Boolean(u.deletedAt),
      deletedAt: u.deletedAt || null,
      lastLogin: u.lastLogin,
      createdAt: u.createdAt,
      organizationId: u.organization?._id,
      organizationName: u.organization?.name || '—',
      organizationSlug: u.organization?.slug || ''
    }));

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0
      }
    };
  }

  /**
   * Paginated agent-role users for an organization (super-admin user detail → Agents tab).
   */
  /**
   * Aggregated snapshot for admin "Insights" tab: activity trends, inbox workload, content, notifications.
   */
  async buildUserInsights(userId, orgId) {
    const Interaction = require('../models/Interaction');
    const ScheduledPost = require('../models/ScheduledPost');
    const Notification = require('../models/Notification');
    const AuditLog = require('../models/AuditLog');
    const KnowledgeBase = require('../models/KnowledgeBase');

    const uid = new mongoose.Types.ObjectId(userId);
    const hasOrg =
      orgId != null &&
      orgId !== '' &&
      mongoose.Types.ObjectId.isValid(String(orgId));
    const oid = hasOrg ? new mongoose.Types.ObjectId(String(orgId)) : null;

    const now = Date.now();
    const since24 = new Date(now - 86400000);
    const since7 = new Date(now - 7 * 86400000);
    const since30 = new Date(now - 30 * 86400000);

    const activityBucket = async (since) => {
      const rows = await UserActivityLog.aggregate([
        { $match: { user: uid, createdAt: { $gte: since } } },
        { $group: { _id: '$category', count: { $sum: 1 } } }
      ]);
      const out = { api: 0, auth: 0, navigation: 0, total: 0 };
      for (const r of rows) {
        const k = r._id;
        if (k && Object.prototype.hasOwnProperty.call(out, k)) {
          out[k] = r.count;
        }
      }
      out.total = out.api + out.auth + out.navigation;
      return out;
    };

    const [
      lastAct,
      totalActivity,
      b24,
      b7,
      b30,
      topPathsRaw
    ] = await Promise.all([
      UserActivityLog.findOne({ user: uid })
        .sort({ createdAt: -1 })
        .select('createdAt category action path method')
        .lean(),
      UserActivityLog.countDocuments({ user: uid }),
      activityBucket(since24),
      activityBucket(since7),
      activityBucket(since30),
      UserActivityLog.aggregate([
        {
          $match: {
            user: uid,
            createdAt: { $gte: since7 },
            path: { $exists: true, $nin: [null, ''] }
          }
        },
        { $group: { _id: '$path', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ])
    ]);

    let workload = null;
    if (oid) {
      const [
        interactionsAssigned,
        interactionsOpen,
        scheduledTotal,
        scheduledByStatus,
        notifTotal,
        notifUnread,
        auditTotal,
        kbCreated
      ] = await Promise.all([
        Interaction.countDocuments({ organization: oid, assignedTo: uid }),
        Interaction.countDocuments({
          organization: oid,
          assignedTo: uid,
          status: { $nin: ['resolved', 'spam', 'archived'] }
        }),
        ScheduledPost.countDocuments({ organization: oid, user: uid }),
        ScheduledPost.aggregate([
          { $match: { organization: oid, user: uid } },
          { $group: { _id: '$status', count: { $sum: 1 } } }
        ]),
        Notification.countDocuments({ user: uid }),
        Notification.countDocuments({ user: uid, isRead: false }),
        AuditLog.countDocuments({ organization: oid, userId: uid }),
        KnowledgeBase.countDocuments({ organization: oid, createdBy: uid })
      ]);

      const byStatus = {};
      scheduledByStatus.forEach((s) => {
        if (s._id) byStatus[s._id] = s.count;
      });

      workload = {
        interactions: {
          assignedTotal: interactionsAssigned,
          assignedOpen: interactionsOpen
        },
        scheduledPosts: {
          total: scheduledTotal,
          byStatus
        },
        notifications: {
          total: notifTotal,
          unread: notifUnread
        },
        auditLogsWritten: auditTotal,
        knowledgeBaseEntriesCreated: kbCreated
      };
    }

    return {
      activity: {
        lastAt: lastAct?.createdAt || null,
        lastCategory: lastAct?.category || null,
        lastSummary: lastAct
          ? [lastAct.method, lastAct.action, lastAct.path].filter(Boolean).join(' · ')
          : null,
        totalEvents: totalActivity,
        last24h: b24,
        last7d: b7,
        last30d: b30,
        topPaths7d: topPathsRaw.map((r) => ({ path: r._id, count: r.count }))
      },
      workload
    };
  }

  async listOrganizationAgents(organizationId, options = {}) {
    const oid = String(organizationId);
    if (!mongoose.Types.ObjectId.isValid(oid)) {
      return {
        items: [],
        pagination: { page: 1, limit: 15, total: 0, pages: 0 }
      };
    }
    const page = Math.max(1, parseInt(options.page, 10) || 1);
    let limit = parseInt(options.limit, 10) || 15;
    limit = Math.min(Math.max(1, limit), 100);
    const skip = (page - 1) * limit;

    const agentFilter = {
      organization: organizationId,
      role: 'agent',
      deletedAt: null
    };

    const [total, raw] = await Promise.all([
      User.countDocuments(agentFilter),
      User.find(agentFilter)
        .select('email firstName lastName isActive lastLogin createdAt')
        .sort({ firstName: 1, lastName: 1, email: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    const items = raw.map((a) => ({
      _id: a._id,
      email: a.email,
      firstName: a.firstName,
      lastName: a.lastName,
      role: 'agent',
      isActive: a.isActive,
      lastLogin: a.lastLogin,
      createdAt: a.createdAt
    }));

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0
      }
    };
  }

  /**
   * Full user for super-admin detail view (no password, tokens, or OAuth secrets).
   * Query: creditsPage, creditsLimit (1–200, default 25) — paginates this user's AI credit events.
   * Query: agentsPage, agentsLimit (1–100, default 15) — paginates org agents on detail.
   */
  async getUserDetailById(userId, query = {}) {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      const err = new Error('Invalid user id');
      err.statusCode = 400;
      throw err;
    }

    const u = await User.findById(userId)
      .select('-password -passwordResetToken -emailVerificationToken')
      .populate('organization', 'name slug subscription.plan subscription.status limits usage createdAt')
      .lean();

    if (!u) {
      const err = new Error('User not found');
      err.statusCode = 404;
      throw err;
    }

    const { oauth: rawOauth, ...rest } = u;
    const oauth = rawOauth
      ? {
          provider: rawOauth.provider ?? null,
          hasLinkedAccount: Boolean(rawOauth.provider)
        }
      : null;

    const orgRef = u.organization;
    const orgId =
      orgRef && typeof orgRef === 'object' && orgRef._id != null ? orgRef._id : orgRef;

    let _meta = {
      aiCreditsOrg: null,
      organizationSubscription: null,
      platformConnections: null,
      userAiCreditUsage: null,
      organizationAgents: null,
      insights: null
    };

    const aiCreditService = require('./aiCreditService');
    const Subscription = require('../models/Subscription');
    const orgIdStr = orgId ? String(orgId) : null;

    const creditsPage = Math.max(1, parseInt(query.creditsPage, 10) || 1);
    let creditsLimit = parseInt(query.creditsLimit, 10) || 25;
    creditsLimit = Math.min(Math.max(1, creditsLimit), 200);

    const agentsPage = Math.max(1, parseInt(query.agentsPage, 10) || 1);
    let agentsLimit = parseInt(query.agentsLimit, 10) || 15;
    agentsLimit = Math.min(Math.max(1, agentsLimit), 100);

    const [
      usageRaw,
      subscription,
      connTotal,
      activeConnCount,
      connList,
      userCreditHistory,
      orgAgents,
      insights,
      passwordRow
    ] = await Promise.all([
      orgIdStr
        ? aiCreditService.getUsage(orgIdStr)
        : Promise.resolve({
            current: 0,
            limit: 0,
            remaining: 0,
            percentage: 0,
            isUnlimited: true,
            isNearLimit: false,
            isAtLimit: false
          }),
      orgId
        ? Subscription.findOne({ organization: orgId })
            .select('planId planName limits usage status billingCycle')
            .lean()
        : Promise.resolve(null),
      orgId
        ? PlatformConnection.countDocuments({ organization: orgId })
        : Promise.resolve(0),
      orgId
        ? PlatformConnection.countDocuments({ organization: orgId, isActive: true })
        : Promise.resolve(0),
      orgId
        ? PlatformConnection.find({ organization: orgId })
            .select(
              'platform platformUsername platformDisplayName status isActive usesAccountSlot createdAt connectedAt createdBy'
            )
            .populate('createdBy', 'email firstName lastName')
            .sort({ createdAt: -1 })
            .limit(200)
            .lean()
        : Promise.resolve([]),
      orgIdStr
        ? aiCreditService.getUsageHistoryForUser(orgIdStr, userId, {
            page: creditsPage,
            limit: creditsLimit
          })
        : Promise.resolve({
            items: [],
            lifetimeCreditsUsed: 0,
            pagination: { page: 1, limit: creditsLimit, total: 0, pages: 0 }
          }),
      orgId
        ? this.listOrganizationAgents(orgId, { page: agentsPage, limit: agentsLimit })
        : Promise.resolve({
            items: [],
            pagination: { page: 1, limit: agentsLimit, total: 0, pages: 0 }
          }),
      this.buildUserInsights(userId, orgId),
      User.findById(userId)
        .select('+adminRecoverablePassword adminPasswordSetAt oauth.provider oauth.providerId')
        .lean()
    ]);

    if (orgId) {
      _meta = {
        aiCreditsOrg: {
          usedThisMonth: usageRaw.current,
          limitPerMonth: usageRaw.limit,
          remainingThisMonth: usageRaw.isUnlimited ? null : usageRaw.remaining,
          percentageUsed: usageRaw.percentage,
          isUnlimited: usageRaw.isUnlimited,
          isNearLimit: usageRaw.isNearLimit,
          isAtLimit: usageRaw.isAtLimit
        },
        organizationSubscription: subscription,
        platformConnections: {
          totalInOrg: connTotal,
          activeCount: activeConnCount,
          maxAccountsLimit: subscription?.limits?.maxAccounts ?? null,
          subscriptionTrackedConnections: subscription?.usage?.connectedAccounts ?? null,
          items: connList,
          itemsTruncated: connTotal > connList.length
        },
        userAiCreditUsage: {
          items: userCreditHistory.items,
          lifetimeCreditsUsed: userCreditHistory.lifetimeCreditsUsed,
          pagination: userCreditHistory.pagination
        },
        organizationAgents: orgAgents,
        insights
      };
    } else {
      _meta = {
        aiCreditsOrg: null,
        organizationSubscription: null,
        platformConnections: null,
        userAiCreditUsage: null,
        organizationAgents: null,
        insights
      };
    }

    _meta.passwordInfo = passwordRow
      ? this.buildPasswordRevealInfo(passwordRow)
      : this.buildPasswordRevealInfo(u);

    return {
      ...rest,
      oauth,
      isDeleted: Boolean(u.deletedAt),
      _meta
    };
  }

  async getUserByIdForAdmin(userId) {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      const err = new Error('Invalid user id');
      err.statusCode = 400;
      throw err;
    }
    const user = await User.findById(userId).populate('organization', 'name slug');
    if (!user) {
      const err = new Error('User not found');
      err.statusCode = 404;
      throw err;
    }
    return user;
  }

  /**
   * Paginated activity for Super Admin (API usage, auth, SPA navigation).
   */
  async listUserActivity(userId, query) {
    await this.getUserByIdForAdmin(userId);
    const { page, limit, skip } = parsePagination(query);
    const filter = { user: userId };
    const [items, total] = await Promise.all([
      UserActivityLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(
          'category action path method statusCode ip userAgent metadata createdAt'
        )
        .lean(),
      UserActivityLog.countDocuments(filter)
    ]);
    const pages = total === 0 ? 0 : Math.ceil(total / limit);
    return {
      items,
      pagination: { page, limit, total, pages }
    };
  }

  async assertNotLastSuperAdmin(targetUser) {
    if (targetUser.role !== 'super_admin') return;
    const others = await User.countDocuments({
      role: 'super_admin',
      deletedAt: null,
      _id: { $ne: targetUser._id }
    });
    if (others < 1) {
      const err = new Error('Cannot remove or deactivate the last super admin');
      err.statusCode = 400;
      throw err;
    }
  }

  /**
   * @param {import('mongoose').Types.ObjectId|string} actorUserId
   */
  async setUserActive(actorUserId, targetUserId, isActive) {
    const target = await this.getUserByIdForAdmin(targetUserId);
    const actorId = String(actorUserId);
    if (String(target._id) === actorId && !isActive) {
      const err = new Error('You cannot deactivate or delete your own account');
      err.statusCode = 400;
      throw err;
    }
    if (!isActive) {
      await this.assertNotLastSuperAdmin(target);
    }
    target.isActive = Boolean(isActive);
    if (isActive) {
      target.deletedAt = null;
    }
    await target.save();
    return target.toJSON();
  }

  /**
   * Soft delete: sets deletedAt and isActive false.
   */
  async softDeleteUser(actorUserId, targetUserId) {
    const target = await this.getUserByIdForAdmin(targetUserId);
    const actorId = String(actorUserId);
    if (String(target._id) === actorId) {
      const err = new Error('You cannot delete your own account');
      err.statusCode = 400;
      throw err;
    }
    await this.assertNotLastSuperAdmin(target);
    target.deletedAt = new Date();
    target.isActive = false;
    await target.save();
    return target.toJSON();
  }

  /**
   * Resolve the tenant user to impersonate when super-admin clicks "Login as organization".
   */
  async resolveOrganizationLoginUser(orgId) {
    if (!mongoose.Types.ObjectId.isValid(orgId)) {
      const err = new Error('Invalid organization id');
      err.statusCode = 400;
      throw err;
    }

    const baseFilter = {
      organization: orgId,
      isActive: true,
      deletedAt: null,
      role: { $ne: 'super_admin' }
    };

    let user = await User.findOne({ ...baseFilter, role: 'admin' })
      .sort({ createdAt: 1 })
      .select('_id email firstName lastName role isActive deletedAt oauth');

    if (!user) {
      user = await User.findOne({ ...baseFilter, role: { $in: ['manager', 'viewer'] } })
        .sort({ createdAt: 1 })
        .select('_id email firstName lastName role isActive deletedAt oauth');
    }

    if (!user) {
      user = await User.findOne({ ...baseFilter, role: 'agent' })
        .sort({ createdAt: 1 })
        .select('_id email firstName lastName role isActive deletedAt oauth');
    }

    if (!user) {
      const err = new Error('No active user found for this organization');
      err.statusCode = 404;
      throw err;
    }

    return user;
  }

  assertImpersonationTarget(target) {
    if (!target) {
      const err = new Error('User not found');
      err.statusCode = 404;
      throw err;
    }
    if (target.deletedAt) {
      const err = new Error('Cannot impersonate a removed user');
      err.statusCode = 400;
      throw err;
    }
    if (!target.isActive) {
      const err = new Error('Cannot impersonate an inactive user');
      err.statusCode = 400;
      throw err;
    }
    if (target.role === 'super_admin') {
      const err = new Error('Cannot impersonate a super admin account');
      err.statusCode = 403;
      throw err;
    }
  }

  buildPasswordRevealInfo(userDoc) {
    const oauthProvider = userDoc.oauth?.provider || null;
    const hasOAuth = Boolean(oauthProvider);
    const decrypted = userDoc.adminRecoverablePassword
      ? decryptAdminPassword(userDoc.adminRecoverablePassword)
      : null;

    return {
      authMethod: hasOAuth && !decrypted ? 'oauth' : 'local',
      oauthProvider,
      passwordAvailable: Boolean(decrypted),
      password: decrypted,
      passwordSetAt: userDoc.adminPasswordSetAt || null,
      message: decrypted
        ? null
        : hasOAuth
          ? 'This user signs in with OAuth. Reset password to set a local login password.'
          : 'Password is hashed. Use Reset & reveal to generate a new password.'
    };
  }

  async getUserPasswordReveal(userId) {
    const user = await User.findById(userId)
      .select('+adminRecoverablePassword adminPasswordSetAt oauth.provider oauth.providerId')
      .lean();

    if (!user) {
      const err = new Error('User not found');
      err.statusCode = 404;
      throw err;
    }

    return this.buildPasswordRevealInfo(user);
  }

  async resetUserPasswordReveal(actorUserId, targetUserId, body = {}) {
    const target = await User.findById(targetUserId).select('+password oauth.provider');
    if (!target) {
      const err = new Error('User not found');
      err.statusCode = 404;
      throw err;
    }

    let plain = body?.password != null ? String(body.password).trim() : '';
    if (plain && plain.length < 6) {
      const err = new Error('Password must be at least 6 characters');
      err.statusCode = 400;
      throw err;
    }
    if (!plain) {
      plain = crypto.randomBytes(9).toString('base64url').slice(0, 12);
    }

    target.password = plain;
    target.adminRecoverablePassword = encryptAdminPassword(plain);
    target.adminPasswordSetAt = new Date();
    target.adminPasswordSetBy = actorUserId;
    await target.save();

    return {
      userId: String(target._id),
      email: target.email,
      password: plain,
      passwordSetAt: target.adminPasswordSetAt
    };
  }

  async buildImpersonationSession(actorUserId, targetUserId) {
    const target = await User.findById(targetUserId)
      .select('_id email firstName lastName role isActive deletedAt organization oauth.provider')
      .populate('organization', 'name slug')
      .lean();

    this.assertImpersonationTarget(target);

    const token = generateImpersonationToken(target._id, actorUserId);
    const refreshToken = generateRefreshToken(target._id);

    return {
      token,
      refreshToken,
      user: {
        _id: target._id,
        email: target.email,
        firstName: target.firstName,
        lastName: target.lastName,
        role: target.role,
        organization: target.organization
      },
      impersonatedBy: String(actorUserId)
    };
  }

  async impersonateUser(actorUserId, targetUserId) {
    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
      const err = new Error('Invalid user id');
      err.statusCode = 400;
      throw err;
    }
    return this.buildImpersonationSession(actorUserId, targetUserId);
  }

  async impersonateOrganization(actorUserId, organizationId) {
    const target = await this.resolveOrganizationLoginUser(organizationId);
    return this.buildImpersonationSession(actorUserId, target._id);
  }
}

module.exports = new SuperAdminService();
