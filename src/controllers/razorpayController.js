const crypto = require('crypto');
const razorpay = require('../config/razorpay');
const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');
const Transaction = require('../models/Transaction');
const Organization = require('../models/Organization');
const User = require('../models/User');
const logger = require('../config/logger');
const entitlementsService = require('../services/entitlementsService');
const { extractRzpError } = require('../services/razorpayPlanService');

function isValidRazorpayPlanId(id) {
  return typeof id === 'string' && id.startsWith('plan_') && id.length > 5;
}

/** Constant-time comparison of two hex-encoded signatures (avoids timing leaks). */
function safeSignatureEqual(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** True when Razorpay says the resource does not exist (test ID + live keys, etc.). */
function isRzpNotFoundError(err) {
  const code = err?.error?.code;
  const desc = (err?.error?.description || '').toLowerCase();
  const status = err?.statusCode;
  return status === 404 || code === 'BAD_REQUEST_ERROR' && desc.includes('invalid') && desc.includes('not be found');
}

/** For webhook-created transactions: org display name + a user id to link in super-admin (admin first, else earliest user). */
async function resolveTransactionUserContext(organizationId) {
  const oid = organizationId?.toString?.() || organizationId;
  if (!oid) return { organizationName: '', user: null, userEmail: '' };

  const [org, admin] = await Promise.all([
    Organization.findById(oid).select('name').lean(),
    User.findOne({ organization: oid, role: 'admin', deletedAt: null })
      .select('_id email')
      .lean()
  ]);

  if (admin) {
    return {
      organizationName: org?.name || '',
      user: admin._id,
      userEmail: admin.email || ''
    };
  }

  const fallback = await User.findOne({ organization: oid, deletedAt: null })
    .select('_id email')
    .sort({ createdAt: 1 })
    .lean();

  return {
    organizationName: org?.name || '',
    user: fallback?._id || null,
    userEmail: fallback?.email || ''
  };
}

/**
 * @desc    Create a Razorpay Subscription for the selected plan
 * @route   POST /api/razorpay/create-subscription
 * @access  Private
 */
exports.createSubscription = async (req, res, next) => {
  let plan;
  try {
    const planIdRaw = req.body?.planId;
    const planId = planIdRaw != null ? String(planIdRaw).trim() : '';

    if (!planId) {
      return res.status(400).json({ success: false, error: 'planId is required' });
    }

    plan = await Plan.getByPlanId(planId);
    if (!plan) {
      logger.warn('[Razorpay] Plan lookup failed', { sentPlanId: planId });
      return res.status(404).json({
        success: false,
        error: `Plan "${planId}" not found. Available plan IDs are case-insensitive (e.g. starter, pro).`
      });
    }

    if (plan.price === 0 || plan.price === 'free') {
      return res.status(400).json({ success: false, error: 'Free plan does not require payment' });
    }

    if (plan.price === 'custom' || plan.billingCycle === 'custom' || plan.billingCycle === 'lifetime') {
      return res.status(400).json({
        success: false,
        error: 'This plan requires a custom quote. Please contact sales.'
      });
    }

    /**
     * Which billing leg the customer chose.
     *
     * A plan carries two Razorpay plans — monthly and (optionally) annual — because
     * Razorpay plans are single-cycle and immutable. Everything below works off the
     * RESOLVED leg, never `plan.razorpayPlanId` directly, so the annual price shown on
     * the pricing page is the price actually charged.
     */
    const cycleRaw = String(req.body?.billingCycle || 'monthly').trim().toLowerCase();
    if (!['monthly', 'yearly'].includes(cycleRaw)) {
      return res.status(400).json({
        success: false,
        error: 'billingCycle must be "monthly" or "yearly".'
      });
    }
    const isAnnual = cycleRaw === 'yearly';

    if (isAnnual && !(Number(plan.priceAnnual) > 0)) {
      return res.status(400).json({
        success: false,
        error: `The ${plan.name} plan is not offered on annual billing.`
      });
    }

    const razorpayPlanId = isAnnual ? plan.razorpayPlanIdAnnual : plan.razorpayPlanId;
    const amountInr = (isAnnual ? plan.priceAnnualInr : plan.priceInr) || 0;
    // Razorpay caps the schedule by cycle count, so 120 monthly cycles and 120 ANNUAL
    // cycles are not the same promise. Both come to ten years.
    const totalCount = isAnnual ? 10 : 120;

    if (!razorpayPlanId) {
      return res.status(400).json({
        success: false,
        error: isAnnual
          ? `Annual billing for "${plan.planId}" is not configured yet. Save the plan in Admin to create its annual Razorpay plan, or choose monthly.`
          : 'This plan is not yet configured for online payment. Save the plan in Admin to create a Razorpay plan, or contact support.'
      });
    }

    if (!isValidRazorpayPlanId(razorpayPlanId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid Razorpay Plan ID on "${plan.planId}". Expected a value like plan_Xxxxx from Razorpay Dashboard, got "${razorpayPlanId}".`
      });
    }

    const subscription = await Subscription.findOne({
      organization: req.user.organization._id
    });
    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription record not found' });
    }

    // Demo workspaces run on an unlimited top-tier internal plan, so every paid plan
    // looks like a "downgrade". Allow them to subscribe to any plan to convert.
    if (!subscription.isDemo && plan.tier < subscription.tier) {
      return res.status(400).json({
        success: false,
        error: 'Changing to a lower-tier plan is not supported. Contact support if you need help.'
      });
    }

    // Cancel previous Razorpay subscription if one exists (may be stale test-mode ID after going live)
    if (subscription.razorpaySubscriptionId) {
      try {
        await razorpay.subscriptions.cancel(subscription.razorpaySubscriptionId, {
          cancel_at_cycle_end: false
        });
      } catch (err) {
        const cancelDesc = extractRzpError(err);
        logger.warn('[Razorpay] Could not cancel previous subscription', {
          id: subscription.razorpaySubscriptionId,
          error: cancelDesc
        });
        if (isRzpNotFoundError(err)) {
          subscription.razorpaySubscriptionId = undefined;
          await subscription.save();
          logger.info('[Razorpay] Cleared stale razorpaySubscriptionId from org subscription');
        }
      }
    }

    // Verify plan exists in current Razorpay mode (live vs test) before checkout
    try {
      await razorpay.plans.fetch(razorpayPlanId);
    } catch (fetchErr) {
      const mode = (process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_live_') ? 'live' : 'test';
      logger.error('[Razorpay] Plan ID not found in Razorpay', {
        appPlanId: plan.planId,
        razorpayPlanId,
        billingCycle: cycleRaw,
        mode,
        error: extractRzpError(fetchErr)
      });
      return res.status(400).json({
        success: false,
        error:
          `Razorpay plan "${razorpayPlanId}" was not found in ${mode} mode. ` +
          `Update the "${plan.planId}" plan in Admin (re-save to auto-create) or set the correct live Plan ID from Razorpay Dashboard → Subscriptions → Plans.`
      });
    }

    // Build notes for customer context
    const notes = {
      organizationId: String(req.user.organization._id),
      userId: String(req.user._id),
      planId,
      planName: plan.name,
      billingCycle: cycleRaw
    };

    const rzpSubscription = await razorpay.subscriptions.create({
      plan_id: razorpayPlanId,
      total_count: totalCount,
      quantity: 1,
      notes
    });

    // Mark subscription as pending_payment while checkout is open
    subscription.status = 'pending_payment';
    subscription.razorpaySubscriptionId = rzpSubscription.id;
    // Record the chosen leg so renewals, the billing page and invoices agree.
    subscription.billingCycle = cycleRaw;
    await subscription.save();

    // Record the order creation event for the admin transactions view
    try {
      const org = req.user.organization;
      await Transaction.create({
        organization: org._id,
        organizationName: org.name || '',
        user: req.user._id,
        userEmail: req.user.email || '',
        planId: plan.planId,
        planName: plan.name,
        razorpaySubscriptionId: rzpSubscription.id,
        amountInr,
        currency: 'INR',
        type: 'order',
        status: 'pending',
        metadata: { billingCycle: cycleRaw }
      });
    } catch (txErr) {
      logger.warn('[Razorpay] Failed to record order transaction', { error: txErr.message });
    }

    logger.info('[Razorpay] Subscription created', {
      razorpaySubscriptionId: rzpSubscription.id,
      planId,
      billingCycle: cycleRaw,
      org: req.user.organization._id
    });

    res.status(200).json({
      success: true,
      data: {
        subscriptionId: rzpSubscription.id,
        keyId: process.env.RAZORPAY_KEY_ID,
        planName: plan.name,
        priceInr: amountInr,
        billingCycle: cycleRaw,
        currency: 'INR'
      }
    });
  } catch (error) {
    // Razorpay SDK wraps errors as { statusCode, error: { description, code, ... } }
    // — not a standard Error. Extract the real description so logs are useful.
    const rzpDesc = error?.error?.description || error?.error?.code || error?.message;
    const rzpCode = error?.error?.code;
    const rzpStatus = error?.statusCode;

    logger.error('[Razorpay] createSubscription error', {
      description: rzpDesc,
      code: rzpCode,
      statusCode: rzpStatus,
      appPlanId: req.body?.planId,
      razorpayPlanId: plan?.razorpayPlanId
    });

    // Surface a human-readable error to the client instead of a generic 500
    if (rzpDesc) {
      const isPlanError = /plan|invalid|not be found/i.test(rzpDesc);
      return res.status(rzpStatus || 400).json({
        success: false,
        error: isPlanError
          ? `Razorpay plan not found for "${req.body?.planId}". Ensure Plan.razorpayPlanId in the database matches a plan in Razorpay ${(process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_live_') ? 'live' : 'test'} mode. (${rzpDesc})`
          : rzpDesc
      });
    }

    next(error);
  }
};

/**
 * @desc    Verify payment signature after checkout completes
 * @route   POST /api/razorpay/verify
 * @access  Private
 */
exports.verifyPayment = async (req, res, next) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, planId } = req.body;

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature || !planId) {
      return res.status(400).json({ success: false, error: 'Missing required payment verification fields' });
    }

    // HMAC-SHA256: key_secret, message: payment_id | subscription_id
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest('hex');

    if (!safeSignatureEqual(expectedSignature, razorpay_signature)) {
      logger.warn('[Razorpay] Payment signature mismatch', { org: req.user.organization._id });
      return res.status(400).json({ success: false, error: 'Payment verification failed. Invalid signature.' });
    }

    const plan = await Plan.getByPlanId(planId);
    if (!plan) {
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }

    const subscription = await Subscription.findOne({
      organization: req.user.organization._id
    });
    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    // Demo workspaces convert in place (see createSubscription) — they sit on a
    // top-tier internal plan, so skip the lower-tier guard for them.
    const wasDemo = subscription.isDemo;
    if (!wasDemo && plan.tier < subscription.tier) {
      return res.status(400).json({
        success: false,
        error: 'Changing to a lower-tier plan is not supported. Contact support if you need help.'
      });
    }

    // Record plan history
    subscription.planHistory.push({
      planId: subscription.planId,
      planName: subscription.planName,
      changedAt: new Date(),
      changedBy: req.user._id,
      reason: 'razorpay_payment'
    });

    // Upgrade plan and activate
    subscription.planId = plan.planId;
    subscription.planName = plan.name;
    subscription.tier = plan.tier;
    subscription.limits = plan.limits;
    subscription.features = plan.features;
    subscription.status = 'active';
    subscription.razorpaySubscriptionId = razorpay_subscription_id;
    subscription.cancelAtPeriodEnd = false;
    subscription.cancelledAt = undefined;
    subscription.cancellationReason = undefined;

    // Set the billing period from the leg the customer actually bought. An annual
    // subscriber given a 30-day period would look "expired" eleven months early.
    const isAnnualCycle = subscription.billingCycle === 'yearly';
    const now = new Date();
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = isAnnualCycle
      ? new Date(new Date(now).setFullYear(now.getFullYear() + 1))
      : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // A demo workspace just paid: convert it in place to a real paid subscription
    // so the trial banner/lock and per-demo credit cap no longer apply.
    if (wasDemo) {
      subscription.isDemo = false;
      subscription.demoStatus = 'converted';
      subscription.convertedAt = now;
      subscription.demoCreditsCap = null;
      subscription.trialEndsAt = undefined;
    }

    await subscription.save();
    await entitlementsService.invalidateEntitlements(subscription.organization);

    // Record the completed payment event for the admin transactions view
    try {
      const org = req.user.organization;
      await Transaction.create({
        organization: org._id,
        organizationName: org.name || '',
        user: req.user._id,
        userEmail: req.user.email || '',
        planId: plan.planId,
        planName: plan.name,
        razorpaySubscriptionId: razorpay_subscription_id,
        razorpayPaymentId: razorpay_payment_id,
        amountInr: (isAnnualCycle ? plan.priceAnnualInr : plan.priceInr) || 0,
        currency: 'INR',
        type: 'payment',
        status: 'completed',
        metadata: { billingCycle: subscription.billingCycle }
      });
    } catch (txErr) {
      logger.warn('[Razorpay] Failed to record payment transaction', { error: txErr.message });
    }

    logger.info('[Razorpay] Payment verified and subscription activated', {
      planId,
      razorpay_subscription_id,
      org: req.user.organization._id
    });

    res.status(200).json({
      success: true,
      message: `Successfully upgraded to ${plan.name} plan`,
      data: {
        planId: subscription.planId,
        planName: subscription.planName,
        status: subscription.status
      }
    });
  } catch (error) {
    logger.error('[Razorpay] verifyPayment error', { error: error.message });
    next(error);
  }
};

/**
 * @desc    Handle Razorpay webhook events
 * @route   POST /api/razorpay/webhook
 * @access  Public (Razorpay server → our server, verified by HMAC signature)
 */
exports.handleWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const receivedSignature = req.headers['x-razorpay-signature'];

    if (!receivedSignature || !webhookSecret) {
      return res.status(400).json({ success: false, error: 'Missing webhook signature or secret' });
    }

    // req.body is a raw Buffer (express.raw middleware applied on this route)
    const rawBody = req.body instanceof Buffer ? req.body : Buffer.from(JSON.stringify(req.body));

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (!safeSignatureEqual(expectedSignature, receivedSignature)) {
      logger.warn('[Razorpay Webhook] Signature mismatch');
      return res.status(400).json({ success: false, error: 'Invalid webhook signature' });
    }

    const event = JSON.parse(rawBody.toString());
    const eventType = event.event;
    const payload = event.payload;

    logger.info('[Razorpay Webhook] Received event', { eventType });

    switch (eventType) {
      // One-time add-on purchases (contact top-ups, AI recharges). This is where
      // entitlement is actually granted — the checkout callback is only a UX signal.
      case 'order.paid':
      case 'payment.captured':
        await handleOneTimePaymentCaptured(payload);
        break;

      // Every subscription.* handler below assumes it is looking at the PLAN
      // subscription, so add-on events are diverted first and handled on their own.
      case 'subscription.activated':
        if (await handleAddOnSubscriptionEvent(eventType, payload)) break;
        await handleSubscriptionActivated(payload);
        break;

      case 'subscription.charged':
        if (await handleAddOnSubscriptionEvent(eventType, payload)) break;
        await handleSubscriptionCharged(payload);
        break;

      case 'subscription.cancelled':
        // An add-on cancellation must NOT fall through — handleSubscriptionCancelled
        // reverts the org to the free plan, which would be catastrophic here.
        if (await handleAddOnSubscriptionEvent(eventType, payload)) break;
        await handleSubscriptionCancelled(payload);
        break;

      case 'subscription.completed':
        if (await handleAddOnSubscriptionEvent(eventType, payload)) break;
        await handleSubscriptionCompleted(payload);
        break;

      case 'subscription.halted':
      case 'subscription.pending':
        // Only meaningful for add-ons today; the plan flow has no handler for these.
        await handleAddOnSubscriptionEvent(eventType, payload);
        break;

      case 'payment.failed':
        await handlePaymentFailed(payload);
        break;

      default:
        logger.info('[Razorpay Webhook] Unhandled event type', { eventType });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('[Razorpay Webhook] Error processing webhook', { error: error.message });
    // Always return 200 to prevent Razorpay from retrying on our bugs
    res.status(200).json({ success: false, error: 'Webhook processing error' });
  }
};

// ─── Webhook event handlers ───────────────────────────────────────────────────

/**
 * Is this subscription webhook about a recurring ADD-ON rather than the plan?
 *
 * Recurring add-ons get their own Razorpay subscription (the plan subscription is
 * cancelled and recreated on every upgrade, which would destroy anything bundled into
 * it). Every subscription.* handler below assumes it is looking at the plan, so
 * add-on events must be diverted before they reach one.
 */
async function handleAddOnSubscriptionEvent(eventType, payload) {
  const entity = payload?.subscription?.entity;
  const razorpaySubscriptionId = entity?.id;
  if (!razorpaySubscriptionId) return false;

  const SubscriptionAddOn = require('../models/SubscriptionAddOn');
  const addOnSub = await SubscriptionAddOn.findOne({ razorpaySubscriptionId })
    .select('addOnId')
    .lean();
  if (!addOnSub) return false;     // it's the plan subscription — not ours

  const {
    activateAddOnSubscription,
    markAddOnPastDue,
    finaliseAddOnCancellation
  } = require('../services/razorpayAddOnSubscriptionService');

  // Razorpay sends period bounds as unix seconds.
  const toDate = (s) => (s ? new Date(Number(s) * 1000) : undefined);

  switch (eventType) {
    case 'subscription.activated':
    case 'subscription.charged':
      await activateAddOnSubscription(razorpaySubscriptionId, {
        periodStart: toDate(entity.current_start),
        periodEnd: toDate(entity.current_end)
      });
      break;

    case 'subscription.halted':
    case 'subscription.pending':
      // A renewal failed. Keep the entitlement for now — stripping seats mid-cycle on
      // one failed charge is worse for the customer than carrying them a few days.
      await markAddOnPastDue(razorpaySubscriptionId);
      break;

    case 'subscription.cancelled':
    case 'subscription.completed':
      await finaliseAddOnCancellation(razorpaySubscriptionId);
      break;

    default:
      break;
  }

  logger.info('[Razorpay Webhook] add-on subscription event handled', {
    eventType,
    razorpaySubscriptionId,
    addOnId: addOnSub.addOnId
  });
  return true;
}

/**
 * A one-time payment succeeded — grant the add-on.
 *
 * Both `order.paid` and `payment.captured` can arrive for the same purchase; the
 * fulfilment guard makes handling both harmless and means we grant on whichever
 * lands first.
 */
async function handleOneTimePaymentCaptured(payload) {
  const order = payload?.order?.entity;
  const payment = payload?.payment?.entity;
  const razorpayOrderId = order?.id || payment?.order_id;

  if (!razorpayOrderId) {
    logger.info('[Razorpay Webhook] payment without an order id — not an add-on purchase');
    return;
  }

  const { fulfilOneTimePurchase } = require('../services/addOnFulfilmentService');
  const result = await fulfilOneTimePurchase({
    razorpayOrderId,
    razorpayPaymentId: payment?.id
  });

  logger.info('[Razorpay Webhook] one-time purchase handled', {
    razorpayOrderId,
    fulfilled: result.fulfilled,
    reason: result.reason
  });
}

async function handleSubscriptionActivated(payload) {
  const rzpSub = payload?.subscription?.entity;
  if (!rzpSub?.id) return;

  const subscription = await Subscription.findOne({ razorpaySubscriptionId: rzpSub.id });
  if (!subscription) return;

  subscription.status = 'active';
  if (rzpSub.current_end) {
    subscription.currentPeriodEnd = new Date(rzpSub.current_end * 1000);
    subscription.razorpayNextBillingAt = new Date(rzpSub.current_end * 1000);
  }
  await subscription.save();
  logger.info('[Razorpay Webhook] Subscription activated', { razorpaySubscriptionId: rzpSub.id });
}

async function handleSubscriptionCharged(payload) {
  const rzpSub = payload?.subscription?.entity;
  if (!rzpSub?.id) return;

  const subscription = await Subscription.findOne({ razorpaySubscriptionId: rzpSub.id });
  if (!subscription) return;

  subscription.status = 'active';
  // Extend billing period by 30 days from current end (or now if missing)
  const periodStart = subscription.currentPeriodEnd || new Date();
  subscription.currentPeriodStart = periodStart;
  subscription.currentPeriodEnd = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);

  if (rzpSub.current_end) {
    subscription.currentPeriodEnd = new Date(rzpSub.current_end * 1000);
    subscription.razorpayNextBillingAt = new Date(rzpSub.current_end * 1000);
  }

  await subscription.save();

  // Record renewal payment event
  try {
    const payment = payload?.payment?.entity;
    const ctx = await resolveTransactionUserContext(subscription.organization);
    await Transaction.create({
      organization: subscription.organization,
      organizationName: ctx.organizationName,
      user: ctx.user || undefined,
      userEmail: ctx.userEmail,
      planId: subscription.planId,
      planName: subscription.planName,
      razorpaySubscriptionId: rzpSub.id,
      razorpayPaymentId: payment?.id || null,
      amountInr: payment?.amount || 0,
      currency: payment?.currency || 'INR',
      type: 'renewal',
      status: 'completed',
      metadata: { rzpSubscription: rzpSub }
    });
  } catch (txErr) {
    logger.warn('[Razorpay Webhook] Failed to record renewal transaction', { error: txErr.message });
  }

  logger.info('[Razorpay Webhook] Subscription charged — period extended', { razorpaySubscriptionId: rzpSub.id });
}

async function handleSubscriptionCancelled(payload) {
  const rzpSub = payload?.subscription?.entity;
  if (!rzpSub?.id) return;

  const subscription = await Subscription.findOne({ razorpaySubscriptionId: rzpSub.id });
  if (!subscription) return;

  subscription.cancelAtPeriodEnd = true;
  if (!subscription.cancelledAt) subscription.cancelledAt = new Date();
  await subscription.save();
  logger.info('[Razorpay Webhook] Subscription cancelled (will expire at period end)', { razorpaySubscriptionId: rzpSub.id });
}

async function handleSubscriptionCompleted(payload) {
  const rzpSub = payload?.subscription?.entity;
  if (!rzpSub?.id) return;

  const subscription = await Subscription.findOne({ razorpaySubscriptionId: rzpSub.id });
  if (!subscription) return;

  // Revert to free plan when paid subscription ends
  const freePlan = await Plan.getByPlanId('free');
  if (freePlan) {
    subscription.planHistory.push({
      planId: subscription.planId,
      planName: subscription.planName,
      changedAt: new Date(),
      reason: 'subscription_completed'
    });
    subscription.planId = freePlan.planId;
    subscription.planName = freePlan.name;
    subscription.tier = freePlan.tier;
    subscription.limits = freePlan.limits;
    subscription.features = freePlan.features;
  }
  subscription.status = 'cancelled';
  subscription.razorpaySubscriptionId = undefined;
  await subscription.save();
  await entitlementsService.invalidateEntitlements(subscription.organization);
  logger.info('[Razorpay Webhook] Subscription completed — reverted to free plan', { razorpaySubscriptionId: rzpSub.id });
}

async function handlePaymentFailed(payload) {
  const rzpPayment = payload?.payment?.entity;
  if (!rzpPayment?.subscription_id) return;

  const subscription = await Subscription.findOne({ razorpaySubscriptionId: rzpPayment.subscription_id });
  if (!subscription) return;

  subscription.status = 'past_due';
  await subscription.save();

  // Record failed payment event
  try {
    const ctx = await resolveTransactionUserContext(subscription.organization);
    await Transaction.create({
      organization: subscription.organization,
      organizationName: ctx.organizationName,
      user: ctx.user || undefined,
      userEmail: ctx.userEmail,
      planId: subscription.planId,
      planName: subscription.planName,
      razorpaySubscriptionId: rzpPayment.subscription_id,
      razorpayPaymentId: rzpPayment.id,
      amountInr: rzpPayment.amount || 0,
      currency: rzpPayment.currency || 'INR',
      type: 'failed',
      status: 'failed',
      metadata: { error: rzpPayment.error_description || rzpPayment.error_code }
    });
  } catch (txErr) {
    logger.warn('[Razorpay Webhook] Failed to record failed-payment transaction', { error: txErr.message });
  }

  logger.warn('[Razorpay Webhook] Payment failed — subscription marked past_due', {
    razorpaySubscriptionId: rzpPayment.subscription_id
  });
}

/**
 * Cancel Razorpay subscription (called from subscriptionController).
 * @param {string} razorpaySubscriptionId
 * @param {boolean} cancelAtCycleEnd
 */
exports.cancelRazorpaySubscription = async (razorpaySubscriptionId, cancelAtCycleEnd = true) => {
  try {
    await razorpay.subscriptions.cancel(razorpaySubscriptionId, {
      cancel_at_cycle_end: cancelAtCycleEnd ? 1 : 0
    });
    logger.info('[Razorpay] Subscription cancelled via API', { razorpaySubscriptionId, cancelAtCycleEnd });
    return true;
  } catch (error) {
    logger.error('[Razorpay] cancelRazorpaySubscription error', { razorpaySubscriptionId, error: error.message });
    return false;
  }
};
