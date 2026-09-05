'use strict';

/**
 * Payment Controller
 *
 * Customer-facing payment CRUD.
 * organizationId is always derived from req.user.organization.
 */

const paymentService = require('../services/payments/paymentService');
const PaymentAttempt = require('../models/PaymentAttempt');
const PaymentEvent = require('../models/PaymentEvent');
const Refund = require('../models/Refund');
const logger = require('../config/logger');

function _orgId(req) {
  return String(req.user?.organization?._id || req.user?.organization || '');
}

// ── Create / Reuse ────────────────────────────────────────────────────────────

exports.createPayment = async (req, res) => {
  try {
    const organizationId = _orgId(req);
    const {
      orderId,
      amount,
      currency,
      provider,
      integrationId,
      contactId,
      interactionId,
      conversation,
      channel,
      description,
      customerName,
      customerPhone,
      customerEmail,
      expiresAt
    } = req.body || {};

    if (!orderId) return res.status(400).json({ success: false, error: 'orderId is required' });
    if (!amount) return res.status(400).json({ success: false, error: 'amount is required (minor units)' });

    const { payment, created } = await paymentService.createOrReuse({
      organizationId,
      orderId,
      amount: parseInt(amount),
      currency,
      provider,
      integrationId,
      contactId,
      interactionId,
      conversation,
      channel,
      description,
      customerName,
      customerPhone,
      customerEmail,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      createdBy: 'agent',
      agentUserId: req.user._id
    });

    res.status(created ? 201 : 200).json({ success: true, payment, created });
  } catch (err) {
    logger.error('[PaymentController] createPayment error', { error: err.message });
    if (err.code === 'ORDER_NOT_FOUND') return res.status(404).json({ success: false, error: err.message });
    if (err.code === 'INVALID_AMOUNT') return res.status(400).json({ success: false, error: err.message });
    if (err.code === 'NO_INTEGRATION') return res.status(422).json({ success: false, error: err.message });
    if (err.code === 'GATEWAY_ERROR') return res.status(502).json({ success: false, error: err.message });
    res.status(500).json({ success: false, error: 'Failed to create payment' });
  }
};

// ── List ──────────────────────────────────────────────────────────────────────

exports.listPayments = async (req, res) => {
  try {
    const organizationId = _orgId(req);
    const { status, orderId, contactId, provider, from, to, page, limit } = req.query || {};
    const result = await paymentService.list(
      organizationId,
      { status, orderId, contactId, provider, from, to },
      { page, limit }
    );
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[PaymentController] listPayments error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to list payments' });
  }
};

// ── Get ───────────────────────────────────────────────────────────────────────

exports.getPayment = async (req, res) => {
  try {
    const payment = await paymentService.getById(_orgId(req), req.params.id);
    res.json({ success: true, payment });
  } catch (err) {
    if (err.code === 'PAYMENT_NOT_FOUND') return res.status(404).json({ success: false, error: err.message });
    logger.error('[PaymentController] getPayment error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to get payment' });
  }
};

// ── Resend ────────────────────────────────────────────────────────────────────

exports.resendPayment = async (req, res) => {
  try {
    const payment = await paymentService.getById(_orgId(req), req.params.id);
    // TODO (Phase 4): dispatch link on channel
    res.json({ success: true, payment, message: 'Payment link details retrieved. Channel dispatch coming in Phase 4.' });
  } catch (err) {
    if (err.code === 'PAYMENT_NOT_FOUND') return res.status(404).json({ success: false, error: err.message });
    res.status(500).json({ success: false, error: 'Failed to resend payment' });
  }
};

// ── Cancel ────────────────────────────────────────────────────────────────────

exports.cancelPayment = async (req, res) => {
  try {
    const { reason } = req.body || {};
    const payment = await paymentService.cancel(_orgId(req), req.params.id, reason);
    res.json({ success: true, payment });
  } catch (err) {
    if (err.code === 'PAYMENT_NOT_FOUND') return res.status(404).json({ success: false, error: err.message });
    if (err.message.includes('transition')) return res.status(422).json({ success: false, error: err.message });
    logger.error('[PaymentController] cancelPayment error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to cancel payment' });
  }
};

// ── Reconcile ─────────────────────────────────────────────────────────────────

exports.reconcilePayment = async (req, res) => {
  try {
    const payment = await paymentService.reconcileStatus(_orgId(req), req.params.id);
    res.json({ success: true, payment });
  } catch (err) {
    if (err.code === 'PAYMENT_NOT_FOUND') return res.status(404).json({ success: false, error: err.message });
    if (err.code === 'GATEWAY_ERROR') return res.status(502).json({ success: false, error: err.message });
    logger.error('[PaymentController] reconcilePayment error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to reconcile payment' });
  }
};

// ── Refund ────────────────────────────────────────────────────────────────────

exports.refundPayment = async (req, res) => {
  try {
    const { amount, reason, notes } = req.body || {};
    if (!amount) return res.status(400).json({ success: false, error: 'amount is required (minor units)' });
    const result = await paymentService.requestRefund({
      organizationId: _orgId(req),
      paymentId: req.params.id,
      amount: parseInt(amount),
      reason,
      notes,
      agentUserId: req.user._id
    });
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.code === 'PAYMENT_NOT_FOUND') return res.status(404).json({ success: false, error: err.message });
    if (err.code === 'INVALID_STATUS') return res.status(422).json({ success: false, error: err.message });
    if (err.code === 'REFUND_EXCEEDS_BALANCE') return res.status(422).json({ success: false, error: err.message });
    if (err.code === 'GATEWAY_ERROR') return res.status(502).json({ success: false, error: err.message });
    logger.error('[PaymentController] refundPayment error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to process refund' });
  }
};

// ── Attempts / Events / Refunds ───────────────────────────────────────────────

exports.listAttempts = async (req, res) => {
  try {
    const organizationId = _orgId(req);
    const attempts = await PaymentAttempt.find({
      payment: req.params.id,
      organization: organizationId
    })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, attempts });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to list attempts' });
  }
};

exports.listRefunds = async (req, res) => {
  try {
    const organizationId = _orgId(req);
    const refunds = await Refund.find({
      payment: req.params.id,
      organization: organizationId
    })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, refunds });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to list refunds' });
  }
};

exports.listEvents = async (req, res) => {
  try {
    const organizationId = _orgId(req);
    const events = await PaymentEvent.find({
      payment: req.params.id,
      organization: organizationId
    })
      .sort({ createdAt: -1 })
      .select('-safePayload')
      .lean();
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to list events' });
  }
};
