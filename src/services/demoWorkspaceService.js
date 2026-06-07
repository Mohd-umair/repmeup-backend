const crypto = require('crypto');
const Organization = require('../models/Organization');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');
const { encryptAdminPassword } = require('../utils/adminPasswordCipher');
const entitlementsService = require('./entitlementsService');
const demoSeederService = require('./demoSeederService');
const logger = require('../config/logger');

/** Default trial length (days). Super-admin may override per workspace. */
const DEFAULT_TRIAL_DAYS = 30;

/**
 * DemoWorkspaceService — Trial/Demo Workspace Management.
 *
 * A demo workspace is a REAL tenant (Organization + admin User + Subscription)
 * placed on a full-featured trial. Because purchasing mutates the SAME
 * Subscription doc in place (razorpayController.verifyPayment /
 * subscriptionController.upgradePlan), converting a demo to a paid account
 * requires NO data migration — see convertToPaid().
 *
 * Single Responsibility: lifecycle of demo workspaces (create / convert / lock /
 * extend). Data seeding lives in demoSeederService (Phase 2).
 */
class DemoWorkspaceService {
  /**
   * Resolve the plan whose entitlements a demo should run on during the trial.
   * Prefers an explicit planId; otherwise the highest-tier active public plan
   * (so prospects experience the full product). Falls back to 'free'.
   */
  async _resolveTrialPlan(planId) {
    if (planId) {
      const plan = await Plan.getByPlanId(planId);
      if (plan) return plan;
    }
    const top = await Plan.findOne({ isActive: true, isPublic: true })
      .sort({ tier: -1 })
      .exec();
    if (top) return top;
    return Plan.getByPlanId('free');
  }

  /**
   * Create a complete demo workspace for a prospect.
   *
   * @param {Object} params
   * @param {Object} params.prospect          { name, email, company?, phone? } — email is required.
   * @param {string} [params.planId]          Plan to mirror during trial (default: top tier).
   * @param {number} [params.trialDays]       Trial length in days (default 30).
   * @param {import('mongoose').Types.ObjectId|string} [params.actorUserId] Super-admin who created it.
   * @returns {Promise<{ organization, user, subscription, provisionalPassword, magicLinkToken, trialEndsAt }>}
   */
  async createDemoWorkspace(params = {}) {
    const { prospect = {}, planId, trialDays, actorUserId } = params;

    const email = String(prospect.email || '').toLowerCase().trim();
    const name = String(prospect.name || '').trim();
    if (!email) {
      const err = new Error('Prospect email is required');
      err.statusCode = 400;
      throw err;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const err = new Error('Prospect email is invalid');
      err.statusCode = 400;
      throw err;
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      const err = new Error('A user with this email already exists');
      err.statusCode = 409;
      throw err;
    }

    const days = Number.isFinite(trialDays) && trialDays > 0 ? Math.floor(trialDays) : DEFAULT_TRIAL_DAYS;
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const plan = await this._resolveTrialPlan(planId);
    if (!plan) {
      const err = new Error('No subscription plan is configured. Seed plans before creating demos.');
      err.statusCode = 500;
      throw err;
    }

    // Derive a friendly org name + a strong provisional password for the prospect.
    const orgName = prospect.company?.trim() || (name ? `${name}'s Workspace` : `${email.split('@')[0]}'s Workspace`);
    const provisionalPassword = this._generatePassword();

    // Sequential create with cleanup-on-failure (matches authService.register style;
    // avoids assuming a replica set for transactions).
    let organization, user, subscription;
    try {
      organization = await Organization.create({
        name: orgName,
        owner: null,
        subscription: { plan: plan.planId, status: 'trial', startDate: now },
        demo: {
          isDemo: true,
          prospect: {
            name,
            email,
            company: String(prospect.company || '').trim(),
            phone: String(prospect.phone || '').trim()
          },
          createdViaSuperAdmin: true,
          createdBy: actorUserId || undefined,
          // seededAt set by demoSeederService (Phase 2)
        }
      });

      // Magic-link token (raw shared once, hash stored).
      const rawMagicToken = crypto.randomBytes(32).toString('hex');
      const hashedMagicToken = crypto.createHash('sha256').update(rawMagicToken).digest('hex');

      const [firstName, ...rest] = (name || email.split('@')[0]).split(' ');
      const lastName = rest.join(' ') || 'Demo';

      user = await User.create({
        email,
        password: provisionalPassword,            // hashed by pre-save hook
        firstName: firstName || 'Demo',
        lastName,
        role: 'admin',                            // first user is workspace admin
        organization: organization._id,
        isActive: true,
        isEmailVerified: true,                    // demo prospects skip email verification
        adminRecoverablePassword: encryptAdminPassword(provisionalPassword),
        adminPasswordSetAt: now,
        adminPasswordSetBy: actorUserId || undefined,
        demoMagicToken: hashedMagicToken,
        demoMagicTokenExpires: trialEndsAt,       // magic link valid for the trial window
        metadata: { signupSource: 'super_admin_demo', isDemoProspect: true }
      });

      organization.owner = user._id;
      organization.usage = organization.usage || {};
      organization.usage.currentUsers = 1;
      await organization.save();

      subscription = await Subscription.create({
        organization: organization._id,
        planId: plan.planId,
        planName: plan.name,
        tier: plan.tier,
        limits: plan.limits,
        features: plan.features,
        status: 'trialing',
        currentPeriodStart: now,
        trialEndsAt,
        isDemo: true,
        demoStatus: 'trialing',
        usage: { activeUsers: 1 },
        planHistory: [{
          planId: plan.planId,
          planName: plan.name,
          changedAt: now,
          changedBy: actorUserId || undefined,
          reason: 'demo_trial_start'
        }]
      });

      // Fresh entitlements resolve from the new Subscription on next read.
      // Cache invalidation is non-critical (a stale/empty cache key just causes a
      // DB re-resolve), so a Redis blip must NOT roll back a created workspace.
      try {
        await entitlementsService.invalidateEntitlements(organization._id);
      } catch (cacheErr) {
        logger.warn('[DemoWorkspace] entitlements cache invalidation failed (non-fatal)', { error: cacheErr.message });
      }

      // Populate demo data (inbox/contacts/flows/KB/templates/campaign). Best-effort:
      // the seeder swallows its own errors so a seeding hiccup never fails creation.
      const seedResult = await demoSeederService.seedAll(organization._id, user._id);

      logger.info('[DemoWorkspace] created', {
        orgId: String(organization._id),
        planId: plan.planId,
        trialEndsAt: trialEndsAt.toISOString(),
        prospect: email,
        seeded: seedResult?.seeded === true,
        seedCounts: seedResult?.counts
      });

      return {
        organization,
        user,
        subscription,
        provisionalPassword,
        magicLinkToken: rawMagicToken,
        trialEndsAt
      };
    } catch (error) {
      // Best-effort cleanup so a half-created demo doesn't linger.
      try { if (user?._id) await User.deleteOne({ _id: user._id }); } catch (_) { /* ignore */ }
      try { if (subscription?._id) await Subscription.deleteOne({ _id: subscription._id }); } catch (_) { /* ignore */ }
      try { if (organization?._id) await Organization.deleteOne({ _id: organization._id }); } catch (_) { /* ignore */ }
      logger.error('[DemoWorkspace] create failed, rolled back', { error: error.message, prospect: email });
      throw error;
    }
  }

  /**
   * Lock all demo workspaces whose trial has expired. Idempotent — only flips
   * subscriptions still in `trialing`. Sets BOTH the authoritative
   * `Subscription.demoStatus='locked'`/`lockedAt` AND the denormalized
   * `Organization.demo.lockedAt` (read by the protect middleware fast-path).
   * Invalidates entitlements so locked orgs re-resolve immediately.
   * @returns {Promise<{ locked: number, organizationIds: string[] }>}
   */
  async lockExpiredDemos(now = new Date()) {
    const due = await Subscription.find({
      isDemo: true,
      demoStatus: 'trialing',
      trialEndsAt: { $lte: now }
    }).select('_id organization').lean();

    const organizationIds = [];
    for (const sub of due) {
      try {
        await Subscription.updateOne(
          { _id: sub._id },
          { $set: { demoStatus: 'locked', lockedAt: now, status: 'past_due' } }
        );
        await Organization.updateOne(
          { _id: sub.organization },
          { $set: { 'demo.lockedAt': now } }
        );
        try { await entitlementsService.invalidateEntitlements(sub.organization); } catch (_) { /* non-fatal */ }
        organizationIds.push(String(sub.organization));
      } catch (err) {
        logger.warn('[DemoWorkspace] failed to lock expired demo', { orgId: String(sub.organization), error: err.message });
      }
    }

    if (organizationIds.length) {
      logger.info('[DemoWorkspace] locked expired demos', { count: organizationIds.length });
    }
    return { locked: organizationIds.length, organizationIds };
  }

  /**
   * Extend (or revive) a demo trial by N days from now. Works on trialing OR
   * locked demos — extending a locked demo unlocks it. Clears lock flags.
   * @param {import('mongoose').Types.ObjectId|string} organizationId
   * @param {number} days  Days to extend from now (must be > 0).
   * @returns {Promise<{ trialEndsAt: Date }>}
   */
  async extendTrial(organizationId, days) {
    const d = Number(days);
    if (!Number.isFinite(d) || d <= 0) {
      const err = new Error('Extension days must be a positive number');
      err.statusCode = 400;
      throw err;
    }
    const sub = await Subscription.findOne({ organization: organizationId, isDemo: true });
    if (!sub) {
      const err = new Error('No demo subscription found for this organization');
      err.statusCode = 404;
      throw err;
    }
    if (sub.demoStatus === 'converted') {
      const err = new Error('This workspace has already been converted to a paid plan');
      err.statusCode = 409;
      throw err;
    }

    const now = new Date();
    const newEnd = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
    sub.trialEndsAt = newEnd;
    sub.demoStatus = 'trialing';
    sub.status = 'trialing';
    sub.lockedAt = undefined;
    await sub.save();

    await Organization.updateOne(
      { _id: organizationId },
      { $unset: { 'demo.lockedAt': '' } }
    );

    // Refresh the prospect's magic-link expiry to match the new trial window.
    await User.updateOne(
      { organization: organizationId, 'metadata.isDemoProspect': true },
      { $set: { demoMagicTokenExpires: newEnd } }
    );

    try { await entitlementsService.invalidateEntitlements(organizationId); } catch (_) { /* non-fatal */ }
    logger.info('[DemoWorkspace] trial extended', { orgId: String(organizationId), days: d, trialEndsAt: newEnd.toISOString() });
    return { trialEndsAt: newEnd };
  }

  /**
   * Convert a demo workspace to a paid plan IN PLACE — no data migration.
   * Mirrors the canonical purchase mutation (subscriptionController.upgradePlan /
   * razorpayController.verifyPayment): same Subscription doc, new plan applied,
   * status active, demo flags cleared. Use this for super-admin manual conversion;
   * a Razorpay purchase by the prospect achieves the same via verifyPayment.
   * @param {import('mongoose').Types.ObjectId|string} organizationId
   * @param {string} planId
   * @param {import('mongoose').Types.ObjectId|string} [actorUserId]
   * @returns {Promise<{ subscription }>}
   */
  async convertToPaid(organizationId, planId, actorUserId) {
    const plan = await Plan.getByPlanId(planId);
    if (!plan) {
      const err = new Error('Invalid plan ID');
      err.statusCode = 400;
      throw err;
    }
    const sub = await Subscription.findOne({ organization: organizationId });
    if (!sub) {
      const err = new Error('Subscription not found');
      err.statusCode = 404;
      throw err;
    }

    const now = new Date();
    sub.planHistory.push({
      planId: sub.planId,
      planName: sub.planName,
      changedAt: now,
      changedBy: actorUserId || undefined,
      reason: 'demo_conversion'
    });

    // Apply the paid plan (same in-place mutation the purchase path uses).
    sub.planId = plan.planId;
    sub.planName = plan.name;
    sub.tier = plan.tier;
    sub.limits = plan.limits;
    sub.features = plan.features;
    sub.status = 'active';
    sub.currentPeriodStart = now;
    sub.currentPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // Clear demo/trial state — it is now a normal paid subscription.
    sub.demoStatus = 'converted';
    sub.convertedAt = now;
    sub.lockedAt = undefined;
    sub.trialEndsAt = undefined;
    await sub.save();

    await Organization.updateOne(
      { _id: organizationId },
      { $set: { 'demo.convertedAt': now }, $unset: { 'demo.lockedAt': '' } }
    );

    try { await entitlementsService.invalidateEntitlements(organizationId); } catch (_) { /* non-fatal */ }
    logger.info('[DemoWorkspace] converted to paid', { orgId: String(organizationId), planId: plan.planId });
    return { subscription: sub };
  }

  /**
   * List demo workspaces for the super-admin console, newest first, with their
   * live trial status derived from the Subscription.
   * @param {Object} [opts] { status?: 'trialing'|'locked'|'converted', page?, limit? }
   */
  async listDemoWorkspaces(opts = {}) {
    const page = Math.max(1, parseInt(opts.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(opts.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const subFilter = { isDemo: true };
    if (opts.status && ['trialing', 'locked', 'converted'].includes(opts.status)) {
      subFilter.demoStatus = opts.status;
    }

    const [subs, total] = await Promise.all([
      Subscription.find(subFilter)
        .select('organization planId planName status demoStatus trialEndsAt lockedAt convertedAt createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Subscription.countDocuments(subFilter)
    ]);

    const orgIds = subs.map((s) => s.organization);
    const orgs = await Organization.find({ _id: { $in: orgIds } })
      .select('name demo.prospect demo.lockedAt demo.convertedAt demo.seededAt owner createdAt')
      .lean();
    const orgById = new Map(orgs.map((o) => [String(o._id), o]));

    const now = Date.now();
    const items = subs.map((s) => {
      const org = orgById.get(String(s.organization)) || {};
      const endsAt = s.trialEndsAt ? new Date(s.trialEndsAt).getTime() : null;
      const daysRemaining = endsAt != null ? Math.max(0, Math.ceil((endsAt - now) / (24 * 60 * 60 * 1000))) : null;
      return {
        organizationId: String(s.organization),
        organizationName: org.name || '(unknown)',
        prospect: org.demo?.prospect || null,
        ownerUserId: org.owner ? String(org.owner) : null,
        planId: s.planId,
        planName: s.planName,
        demoStatus: s.demoStatus || 'trialing',
        trialEndsAt: s.trialEndsAt || null,
        daysRemaining,
        lockedAt: s.lockedAt || org.demo?.lockedAt || null,
        convertedAt: s.convertedAt || org.demo?.convertedAt || null,
        seededAt: org.demo?.seededAt || null,
        createdAt: org.createdAt || s.createdAt
      };
    });

    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /** Generate a readable but strong provisional password (e.g. "Demo-7F3K9XQ2"). */
  _generatePassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
    let s = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
    return `Demo-${s}`;
  }
}

module.exports = new DemoWorkspaceService();
module.exports.DEFAULT_TRIAL_DAYS = DEFAULT_TRIAL_DAYS;
