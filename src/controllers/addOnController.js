const addOnService = require('../services/addOnService');
const {
  createOneTimeOrder,
  verifyOrderSignature,
  AddOnPurchaseError
} = require('../services/razorpayOrderService');
const { fulfilOneTimePurchase } = require('../services/addOnFulfilmentService');
const {
  createAddOnSubscription,
  verifyAddOnSubscriptionSignature,
  activateAddOnSubscription,
  cancelAddOnSubscription
} = require('../services/razorpayAddOnSubscriptionService');
const SubscriptionAddOn = require('../models/SubscriptionAddOn');
const Transaction = require('../models/Transaction');
const logger = require('../config/logger');

function handlePurchaseError(err, res, next) {
  if (err instanceof AddOnPurchaseError) {
    return res.status(err.statusCode).json({ success: false, error: err.message });
  }
  return next(err);
}

/**
 * @desc    Add-ons purchasable on MY plan, display-ready
 * @route   GET /api/addons
 */
exports.listAvailable = async (req, res, next) => {
  try {
    const items = await addOnService.listAvailableAddOns(req.user.organization._id);
    res.json({ success: true, data: { items } });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    My active add-ons and purchased capacity
 * @route   GET /api/addons/mine
 */
exports.listMine = async (req, res, next) => {
  try {
    const data = await addOnService.listMyAddOns(req.user.organization._id);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Start a one-time purchase (returns a Razorpay order to open checkout with)
 * @route   POST /api/addons/purchase
 */
exports.purchase = async (req, res, next) => {
  try {
    const { addOnId, quantity } = req.body;
    if (!addOnId) {
      return res.status(400).json({ success: false, error: 'addOnId is required' });
    }

    const order = await createOneTimeOrder({
      organizationId: req.user.organization._id,
      organizationName: req.user.organization.name,
      userId: req.user._id,
      userEmail: req.user.email,
      addOnId,
      quantity
    });

    res.status(201).json({ success: true, data: order });
  } catch (err) {
    handlePurchaseError(err, res, next);
  }
};

/**
 * @desc    Confirm checkout returned a valid signature.
 * @route   POST /api/addons/verify
 *
 * This is a UX confirmation only — entitlement is granted by the `order.paid` webhook,
 * so a customer who closes the tab still gets what they paid for. We attempt fulfilment
 * here too purely so the UI can update immediately; the guard makes the double-call safe.
 */
exports.verify = async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!verifyOrderSignature(req.body)) {
      logger.warn('[addOns] order signature mismatch', {
        organizationId: String(req.user.organization._id),
        razorpay_order_id
      });
      return res.status(400).json({ success: false, error: 'Payment verification failed.' });
    }

    const transaction = await Transaction.findOne({ razorpayOrderId: razorpay_order_id })
      .select('organization')
      .lean();
    if (!transaction || String(transaction.organization) !== String(req.user.organization._id)) {
      return res.status(404).json({ success: false, error: 'Purchase not found.' });
    }

    const result = await fulfilOneTimePurchase({
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id
    });

    res.json({
      success: true,
      data: {
        // Either we granted it now, or the webhook beat us to it — both are success.
        applied: result.fulfilled || result.reason === 'already_fulfilled' || result.reason === 'grant_exists',
        ...(await addOnService.listMyAddOns(req.user.organization._id))
      }
    });
  } catch (err) {
    handlePurchaseError(err, res, next);
  }
};

/**
 * @desc    Start a recurring add-on subscription (extra seats, Flow Builder)
 * @route   POST /api/addons/subscribe
 */
exports.subscribe = async (req, res, next) => {
  try {
    const { addOnId, quantity } = req.body;
    if (!addOnId) {
      return res.status(400).json({ success: false, error: 'addOnId is required' });
    }

    const data = await createAddOnSubscription({
      organizationId: req.user.organization._id,
      organizationName: req.user.organization.name,
      userId: req.user._id,
      userEmail: req.user.email,
      addOnId,
      quantity
    });

    res.status(201).json({ success: true, data });
  } catch (err) {
    handlePurchaseError(err, res, next);
  }
};

/**
 * @desc    Confirm a recurring add-on checkout returned a valid signature.
 * @route   POST /api/addons/subscribe/verify
 *
 * UX confirmation only — `subscription.activated` grants the entitlement either way.
 */
exports.verifySubscription = async (req, res, next) => {
  try {
    const { razorpay_subscription_id } = req.body;

    if (!verifyAddOnSubscriptionSignature(req.body)) {
      logger.warn('[addOns] subscription signature mismatch', {
        organizationId: String(req.user.organization._id),
        razorpay_subscription_id
      });
      return res.status(400).json({ success: false, error: 'Payment verification failed.' });
    }

    // A valid signature proves the payment, not that it belongs to THIS org — check.
    const addOnSub = await SubscriptionAddOn.findOne({
      razorpaySubscriptionId: razorpay_subscription_id
    }).select('organization').lean();
    if (!addOnSub || String(addOnSub.organization) !== String(req.user.organization._id)) {
      return res.status(404).json({ success: false, error: 'Subscription not found.' });
    }

    const result = await activateAddOnSubscription(razorpay_subscription_id);

    res.json({
      success: true,
      data: {
        applied: result.activated,
        ...(await addOnService.listMyAddOns(req.user.organization._id))
      }
    });
  } catch (err) {
    handlePurchaseError(err, res, next);
  }
};

/**
 * @desc    Cancel a recurring add-on (at period end by default — they paid for it)
 * @route   DELETE /api/addons/:addOnId/subscription
 */
exports.cancelSubscription = async (req, res, next) => {
  try {
    const result = await cancelAddOnSubscription({
      organizationId: req.user.organization._id,
      addOnId: req.params.addOnId,
      immediate: req.query.immediate === 'true'
    });

    res.json({
      success: true,
      data: {
        ...result,
        ...(await addOnService.listMyAddOns(req.user.organization._id))
      }
    });
  } catch (err) {
    handlePurchaseError(err, res, next);
  }
};
