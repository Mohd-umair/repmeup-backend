'use strict';

/**
 * Turning a paid transaction into entitlement.
 *
 * Fulfilment happens on the WEBHOOK, never in the checkout callback: a customer who
 * closes the tab before the callback fires must still get what they paid for.
 *
 * Razorpay delivers webhooks at least once, so this must be safe to run repeatedly.
 * Two independent guards:
 *   1. a conditional update on `fulfilledAt: null` — only one caller can win it;
 *   2. a unique index on AddOnGrant.transaction — the ledger physically cannot hold
 *      two grants for one payment.
 * And even if both were bypassed, `recomputeOverrides` derives capacity from the
 * ledger rather than incrementing, so the resulting number would still be right.
 */

const AddOn = require('../models/AddOn');
const AddOnGrant = require('../models/AddOnGrant');
const Transaction = require('../models/Transaction');
const addOnService = require('./addOnService');
const logger = require('../config/logger');

/**
 * Grant entitlement for a paid one-time transaction.
 *
 * @param {object} params
 * @param {string} [params.razorpayOrderId] - preferred lookup
 * @param {string} [params.transactionId]   - fallback (order `receipt`)
 * @param {string} [params.razorpayPaymentId]
 * @returns {Promise<{ fulfilled: boolean, reason?: string, grantId?: string }>}
 */
async function fulfilOneTimePurchase({ razorpayOrderId, transactionId, razorpayPaymentId }) {
  const query = razorpayOrderId ? { razorpayOrderId } : { _id: transactionId };
  const transaction = await Transaction.findOne(query);

  if (!transaction) {
    logger.warn('[addOns] fulfilment: no transaction found', { razorpayOrderId, transactionId });
    return { fulfilled: false, reason: 'transaction_not_found' };
  }

  // Guard 1 — claim the transaction. A replay finds it already claimed and stops.
  const claimed = await Transaction.findOneAndUpdate(
    { _id: transaction._id, fulfilledAt: null },
    {
      $set: {
        fulfilledAt: new Date(),
        status: 'completed',
        ...(razorpayPaymentId ? { razorpayPaymentId } : {})
      }
    },
    { new: true }
  );

  if (!claimed) {
    logger.info('[addOns] fulfilment skipped — already fulfilled', {
      transactionId: String(transaction._id)
    });
    return { fulfilled: false, reason: 'already_fulfilled' };
  }

  const line = (claimed.lineItems || [])[0];
  if (!line?.addOnId) {
    logger.error('[addOns] fulfilment: transaction has no add-on line item', {
      transactionId: String(claimed._id)
    });
    return { fulfilled: false, reason: 'no_line_item' };
  }

  const addOn = await AddOn.findOne({ addOnId: line.addOnId }).lean();
  if (!addOn) {
    logger.error('[addOns] fulfilment: add-on no longer exists', { addOnId: line.addOnId });
    return { fulfilled: false, reason: 'addon_not_found' };
  }

  // Guard 2 — the ledger's unique index on `transaction`.
  let grant;
  try {
    grant = await AddOnGrant.create({
      organization: claimed.organization,
      addOnId: addOn.addOnId,
      transaction: claimed._id,
      featureKey: addOn.grant.featureKey,
      mode: addOn.grant.mode,
      amount: line.grantAmount || 0,
      // A monthly recharge only counts for the month it was bought in.
      periodMonthKey: addOn.grant.mode === 'period_credit' ? addOnService.currentMonthKey() : null,
      createdBy: claimed.user || null
    });
  } catch (err) {
    if (err?.code === 11000) {
      logger.info('[addOns] fulfilment: grant already exists for this transaction', {
        transactionId: String(claimed._id)
      });
      return { fulfilled: false, reason: 'grant_exists' };
    }
    throw err;
  }

  await addOnService.recomputeOverrides(claimed.organization);

  logger.info('[addOns] purchase fulfilled', {
    organizationId: String(claimed.organization),
    addOnId: addOn.addOnId,
    featureKey: addOn.grant.featureKey,
    amount: line.grantAmount,
    transactionId: String(claimed._id)
  });

  return { fulfilled: true, grantId: String(grant._id) };
}

module.exports = { fulfilOneTimePurchase };
