'use strict';

/**
 * One-time payments via the Razorpay Orders API.
 *
 * The existing integration only ever created recurring *subscriptions*; there was no
 * path for buying something once (a contact top-up, an AI recharge). This adds it.
 *
 * Idempotency is anchored on the Transaction: we create it BEFORE talking to Razorpay
 * and pass its `_id` as the order `receipt`, so every later webhook can find exactly
 * one row to fulfil, however many times it is delivered.
 *
 * ⚠️ The Orders signature is HMAC over `order_id|payment_id` — the REVERSE of the
 * subscription flow's `payment_id|subscription_id` (razorpayController.verifyPayment).
 * Getting the order wrong silently fails every verification.
 */

const crypto = require('crypto');
const razorpay = require('../config/razorpay');
const AddOn = require('../models/AddOn');
const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const logger = require('../config/logger');

class AddOnPurchaseError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'AddOnPurchaseError';
    this.statusCode = statusCode;
  }
}

function safeSignatureEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Resolve the SKU + the pricing row that applies to this org's plan, and validate
 * the requested quantity. Throws AddOnPurchaseError with a customer-safe message.
 */
async function resolvePurchase(organizationId, addOnId, quantity) {
  const subscription = await Subscription.findOne({ organization: organizationId })
    .select('planId')
    .lean();
  if (!subscription?.planId) {
    throw new AddOnPurchaseError('No active subscription for this organization.', 400);
  }

  const addOn = await AddOn.findOne({ addOnId, isActive: true });
  if (!addOn) throw new AddOnPurchaseError('Add-on not found or inactive.', 404);

  const pricing = addOn.pricingFor(subscription.planId);
  if (!pricing) {
    throw new AddOnPurchaseError(
      `"${addOn.name}" is not available on your current plan.`,
      400
    );
  }
  if (pricing.grantAmount == null && addOn.grant.mode !== 'boolean_grant') {
    throw new AddOnPurchaseError(
      `"${addOn.name}" is not configured for purchase yet. Please contact support.`,
      409
    );
  }

  const qty = Number(quantity) || 1;
  if (!Number.isInteger(qty) || qty < (pricing.minQuantity || 1) || qty > (pricing.maxQuantity || 1)) {
    throw new AddOnPurchaseError(
      `Quantity must be between ${pricing.minQuantity || 1} and ${pricing.maxQuantity || 1}.`,
      400
    );
  }

  return { addOn, pricing, quantity: qty, planId: subscription.planId };
}

/**
 * Create a pending Transaction and a matching Razorpay order.
 *
 * @returns {Promise<{orderId, keyId, amountInr, currency, transactionId, addOn}>}
 */
async function createOneTimeOrder({ organizationId, organizationName, userId, userEmail, addOnId, quantity }) {
  const { addOn, pricing, quantity: qty, planId } =
    await resolvePurchase(organizationId, addOnId, quantity);

  if (addOn.kind !== 'one_time') {
    throw new AddOnPurchaseError('This add-on is a recurring subscription, not a one-time purchase.', 400);
  }

  const amountInr = pricing.priceInr * qty;               // paise
  const grantAmount = (pricing.grantAmount || 0) * qty;

  // Transaction FIRST — its _id is the idempotency key for the whole flow.
  const transaction = await Transaction.create({
    organization: organizationId,
    organizationName: organizationName || '',
    user: userId,
    userEmail: userEmail || '',
    planId,
    amountInr,
    type: 'topup',
    status: 'pending',
    lineItems: [{
      addOnId: addOn.addOnId,
      name: addOn.name,
      quantity: qty,
      unitAmountInr: pricing.priceInr,
      amountInr,
      grantFeatureKey: addOn.grant.featureKey,
      grantAmount
    }],
    metadata: { grantMode: addOn.grant.mode }
  });

  try {
    const order = await razorpay.orders.create({
      amount: amountInr,
      currency: 'INR',
      receipt: String(transaction._id),
      notes: {
        organizationId: String(organizationId),
        addOnId: addOn.addOnId,
        quantity: String(qty),
        transactionId: String(transaction._id)
      }
    });

    transaction.razorpayOrderId = order.id;
    await transaction.save();

    logger.info('[Razorpay] one-time order created', {
      organizationId: String(organizationId),
      addOnId: addOn.addOnId,
      orderId: order.id,
      amountInr
    });

    return {
      orderId: order.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      amountInr,
      currency: 'INR',
      transactionId: String(transaction._id),
      addOn: { addOnId: addOn.addOnId, name: addOn.name, quantity: qty, grantAmount }
    };
  } catch (err) {
    transaction.status = 'failed';
    transaction.metadata = { ...transaction.metadata, error: err?.error?.description || err.message };
    await transaction.save();
    logger.error('[Razorpay] order creation failed', {
      organizationId: String(organizationId),
      addOnId,
      error: err?.error?.description || err.message
    });
    throw new AddOnPurchaseError(
      err?.error?.description || 'Could not start the payment. Please try again.',
      502
    );
  }
}

/**
 * Verify a checkout callback signature.
 *
 * This is a fast UX confirmation only — entitlement is granted by the webhook, so a
 * customer who closes the tab still gets what they paid for.
 */
function verifyOrderSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return false;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    // Orders: order_id|payment_id (subscriptions are payment_id|subscription_id)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  return safeSignatureEqual(expected, razorpay_signature);
}

module.exports = {
  AddOnPurchaseError,
  createOneTimeOrder,
  verifyOrderSignature,
  resolvePurchase
};
