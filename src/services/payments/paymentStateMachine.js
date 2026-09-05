'use strict';

/**
 * Payment State Machine
 *
 * Enforces valid status transitions for Payment records.
 * Any code that moves a payment to a new status MUST go through this module.
 *
 * Valid transitions:
 *   created       → pending, cancelled, expired
 *   pending       → authorized, paid, failed, expired, cancelled
 *   authorized    → paid, failed, cancelled
 *   paid          → partially_refunded, refunded
 *   partially_refunded → refunded
 *
 * Terminal states (no further transitions allowed):
 *   paid, failed, expired, cancelled, refunded
 */

const { PAYMENT_STATUSES, TERMINAL_STATUSES } = require('../../models/Payment');

/** Allowed transitions map */
const TRANSITIONS = {
  created: ['pending', 'cancelled', 'expired'],
  pending: ['authorized', 'paid', 'failed', 'expired', 'cancelled'],
  authorized: ['paid', 'failed', 'cancelled'],
  paid: ['partially_refunded', 'refunded'],
  partially_refunded: ['refunded'],
  failed: [],
  expired: [],
  cancelled: [],
  refunded: []
};

/**
 * Assert that a transition from `fromStatus` to `toStatus` is valid.
 * Throws if the transition is illegal or either status is unknown.
 *
 * @param {string} fromStatus
 * @param {string} toStatus
 * @throws {Error}
 */
function assertTransition(fromStatus, toStatus) {
  if (!PAYMENT_STATUSES.includes(fromStatus)) {
    throw new Error(`paymentStateMachine: unknown source status "${fromStatus}"`);
  }
  if (!PAYMENT_STATUSES.includes(toStatus)) {
    throw new Error(`paymentStateMachine: unknown target status "${toStatus}"`);
  }
  if (TERMINAL_STATUSES.has(fromStatus) && fromStatus !== toStatus) {
    const allowed = TRANSITIONS[fromStatus] || [];
    if (!allowed.includes(toStatus)) {
      throw new Error(
        `paymentStateMachine: transition "${fromStatus}" → "${toStatus}" is illegal (terminal state has no further transitions)`
      );
    }
  }
  const allowed = TRANSITIONS[fromStatus] || [];
  if (!allowed.includes(toStatus)) {
    throw new Error(
      `paymentStateMachine: transition "${fromStatus}" → "${toStatus}" is not allowed. ` +
        `Allowed: [${allowed.join(', ')}]`
    );
  }
}

/**
 * Returns whether a transition is valid (non-throwing version).
 * @param {string} fromStatus
 * @param {string} toStatus
 * @returns {boolean}
 */
function canTransition(fromStatus, toStatus) {
  try {
    assertTransition(fromStatus, toStatus);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns whether a payment in `status` is in a terminal state.
 * @param {string} status
 * @returns {boolean}
 */
function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Returns whether a payment in `status` is still active (can be paid).
 * @param {string} status
 * @returns {boolean}
 */
function isActive(status) {
  return ['created', 'pending', 'authorized'].includes(status);
}

/**
 * Returns whether a payment in `status` supports refunds.
 * @param {string} status
 * @returns {boolean}
 */
function isRefundable(status) {
  return ['paid', 'partially_refunded'].includes(status);
}

/**
 * Returns timestamp field name for a transition.
 * Used to atomically set the lifecycle timestamp alongside status.
 * @param {string} toStatus
 * @returns {string|null}
 */
function timestampFieldFor(toStatus) {
  const map = {
    pending: null,
    authorized: 'authorizedAt',
    paid: 'paidAt',
    failed: 'failedAt',
    expired: 'expiredAt',
    cancelled: 'cancelledAt'
  };
  return map[toStatus] || null;
}

module.exports = {
  assertTransition,
  canTransition,
  isTerminal,
  isActive,
  isRefundable,
  timestampFieldFor,
  TRANSITIONS
};
