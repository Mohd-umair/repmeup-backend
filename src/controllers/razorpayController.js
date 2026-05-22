const crypto = require('crypto');
const razorpay = require('../config/razorpay');
const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');
const Transaction = require('../models/Transaction');
const Organization = require('../models/Organization');
const User = require('../models/User');
const logger = require('../config/logger');
const entitlementsService = require('../services/entitlementsService');

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
  try {
    const { planId } = req.body;

    if (!planId) {
      return res.status(400).json({ success: false, error: 'planId is required' });
    }

    const plan = await Plan.getByPlanId(planId);
    if (!plan) {
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }

    if (plan.price === 0 || plan.price === 'free') {
      return res.status(400).json({ success: false, error: 'Free plan does not require payment' });
    }

    if (!plan.razorpayPlanId) {
      return res.status(400).json({
        success: false,
        error: 'This plan is not yet configured for online payment. Please contact support.'
      });
    }

    // Detect test-mode plan IDs when running with live keys
    const isLiveKey = (process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_live_');
    const isTestPlanId = plan.razorpayPlanId.startsWith('plan_') &&
      !plan.razorpayPlanId.startsWith('plan_Live') && isLiveKey;
    if (isLiveKey && plan.razorpayPlanId && !plan.razorpayPlanId.includes('live') && !plan.razorpayPlanId.includes('Live')) {
      // Razorpay live plans IDs are not prefixed specially, so we query to validate
      // but we can warn in logs for ops visibility
      logger.warn('[Razorpay] Live key in use — ensure razorpayPlanId is a LIVE plan ID, not a test one', {
        razorpayPlanId: plan.razorpayPlanId
      });
    }

    const subscription = await Subscription.findOne({
      organization: req.user.organization._id
    });
    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription record not found' });
    }

    if (plan.tier < subscription.tier) {
      return res.status(400).json({
        success: false,
        error: 'Changing to a lower-tier plan is not supported. Contact support if you need help.'
      });
    }

    // Cancel previous Razorpay subscription if one exists and is active
    if (subscription.razorpaySubscriptionId) {
      try {
        await razorpay.subscriptions.cancel(subscription.razorpaySubscriptionId, {
          cancel_at_cycle_end: false
        });
      } catch (err) {
        const cancelDesc = err?.error?.description || err?.message;
        logger.warn('[Razorpay] Could not cancel previous subscription', {
          id: subscription.razorpaySubscriptionId,
          error: cancelDesc
        });
      }
    }

    // Build notes for customer context
    const notes = {
      organizationId: String(req.user.organization._id),
      userId: String(req.user._id),
      planId,
      planName: plan.name
    };

    const rzpSubscription = await razorpay.subscriptions.create({
      plan_id: plan.razorpayPlanId,
      total_count: 120,          // max billing cycles (10 years for monthly)
      quantity: 1,
      notes
    });

    // Mark subscription as pending_payment while checkout is open
    subscription.status = 'pending_payment';
    subscription.razorpaySubscriptionId = rzpSubscription.id;
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
        amountInr: plan.priceInr || 0,
        currency: 'INR',
        type: 'order',
        status: 'pending'
      });
    } catch (txErr) {
      logger.warn('[Razorpay] Failed to record order transaction', { error: txErr.message });
    }

    logger.info('[Razorpay] Subscription created', {
      razorpaySubscriptionId: rzpSubscription.id,
      planId,
      org: req.user.organization._id
    });

    res.status(200).json({
      success: true,
      data: {
        subscriptionId: rzpSubscription.id,
        keyId: process.env.RAZORPAY_KEY_ID,
        planName: plan.name,
        priceInr: plan.priceInr,
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
      razorpayPlanId: req.body?.planId
    });

    // Surface a human-readable error to the client instead of a generic 500
    if (rzpDesc) {
      return res.status(rzpStatus || 400).json({
        success: false,
        error: rzpDesc.includes('plan id')
          ? `Razorpay plan not found. Please update your plan configuration with the correct live Razorpay Plan ID. (${rzpDesc})`
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

    if (expectedSignature !== razorpay_signature) {
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

    if (plan.tier < subscription.tier) {
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

    // Set billing period (monthly — next billing 30 days from now)
    const now = new Date();
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

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
        amountInr: plan.priceInr || 0,
        currency: 'INR',
        type: 'payment',
        status: 'completed'
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

    if (expectedSignature !== receivedSignature) {
      logger.warn('[Razorpay Webhook] Signature mismatch');
      return res.status(400).json({ success: false, error: 'Invalid webhook signature' });
    }

    const event = JSON.parse(rawBody.toString());
    const eventType = event.event;
    const payload = event.payload;

    logger.info('[Razorpay Webhook] Received event', { eventType });

    switch (eventType) {
      case 'subscription.activated':
        await handleSubscriptionActivated(payload);
        break;

      case 'subscription.charged':
        await handleSubscriptionCharged(payload);
        break;

      case 'subscription.cancelled':
        await handleSubscriptionCancelled(payload);
        break;

      case 'subscription.completed':
        await handleSubscriptionCompleted(payload);
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
