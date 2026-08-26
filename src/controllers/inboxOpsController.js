'use strict';

const orderOps = require('../services/inbox/inboxOrderOpsService');
const complaintOps = require('../services/inbox/inboxComplaintOpsService');
const reviewOps = require('../services/inbox/inboxReviewOpsService');
const replyService = require('../services/replyService');
const Interaction = require('../models/Interaction');
const aiService = require('../services/aiService');

function orgId(req) {
  return req.user.organization._id;
}

// ── Orders ────────────────────────────────────────────────────────────────────

exports.listOrders = async (req, res, next) => {
  try {
    const data = await orderOps.listOrders(orgId(req), req.query);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

exports.getOrderStats = async (req, res, next) => {
  try {
    const data = await orderOps.getOrderStats(orgId(req), req.query);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

exports.getOrderDetail = async (req, res, next) => {
  try {
    const data = await orderOps.getOrderDetail(orgId(req), req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// GET /inbox/ops/orders/by-interaction/:interactionId → lightweight order ref for deep-linking
exports.getOrderByInteraction = async (req, res, next) => {
  try {
    const data = await orderOps.getOrderByInteraction(orgId(req), req.params.interactionId);
    if (!data) return res.status(404).json({ success: false, error: 'No order linked to this conversation' });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

exports.createOrder = async (req, res, next) => {
  try {
    const result = await orderOps.createOrder(orgId(req), req.body);
    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.status(201).json({ success: true, data: result.order });
  } catch (err) {
    next(err);
  }
};

exports.updateOrderStatus = async (req, res, next) => {
  try {
    const { status, note, notes, reason, tracking, refund, paymentMethod, paymentRef } = req.body;
    const actor = req.user?.firstName ? `${req.user.firstName} ${req.user.lastName || ''}`.trim() : undefined;
    const extra = { note: note ?? notes, reason, tracking, refund, paymentMethod, paymentRef, byName: actor };
    const result = await orderOps.updateOrderStatus(orgId(req), req.params.id, status, extra);
    if (result.error === 'not_found') {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true, data: result.order });
  } catch (err) {
    next(err);
  }
};

// PATCH /inbox/ops/orders/:id/shipping → edit structured shipping address + buyer details
exports.updateOrderShipping = async (req, res, next) => {
  try {
    const result = await orderOps.updateOrderShipping(orgId(req), req.params.id, req.body);
    if (result.error === 'not_found') {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true, data: result.order });
  } catch (err) {
    next(err);
  }
};

// ── Complaints ────────────────────────────────────────────────────────────────

// POST /inbox/ops/complaints/from-interaction/:interactionId
exports.createComplaintFromInteraction = async (req, res, next) => {
  try {
    const { issueSummary, priority } = req.body;
    const result = await complaintOps.raiseComplaint(
      orgId(req),
      req.params.interactionId,
      { issueSummary, priority }
    );
    if (result.error === 'invalid_interaction_id') {
      return res.status(400).json({ success: false, error: 'Invalid interaction ID' });
    }
    if (result.error === 'not_found') {
      return res.status(404).json({ success: false, error: 'Interaction not found' });
    }
    if (result.error === 'complaint_already_open') {
      return res.status(409).json({
        success: false,
        error: 'An active complaint already exists for this conversation',
        displayRef: result.displayRef
      });
    }
    res.status(201).json({ success: true, data: result.detail });
  } catch (err) {
    next(err);
  }
};

/**
 * Log a complaint that did not come through a connected channel (walk-in, phone
 * call, reported offline). Unlike createComplaintFromInteraction there is no
 * existing chat, so the service creates the backing Interaction itself.
 */
exports.createManualComplaint = async (req, res, next) => {
  try {
    const { customerName, customerHandle, channel, issueSummary, priority } = req.body;
    const result = await complaintOps.createManualComplaint(orgId(req), {
      customerName,
      customerHandle,
      channel,
      issueSummary,
      priority
    });
    if (result.error === 'customer_name_required') {
      return res.status(400).json({ success: false, error: 'Customer name is required' });
    }
    if (result.error === 'issue_summary_too_short') {
      return res.status(400).json({ success: false, error: 'Describe the issue in at least 5 characters' });
    }
    res.status(201).json({ success: true, data: result.detail });
  } catch (err) {
    next(err);
  }
};

exports.listComplaints = async (req, res, next) => {
  try {
    const data = await complaintOps.listComplaints(orgId(req), req.query);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

exports.getComplaintStats = async (req, res, next) => {
  try {
    const data = await complaintOps.getComplaintStats(orgId(req));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

exports.getComplaintDetail = async (req, res, next) => {
  try {
    const data = await complaintOps.getComplaintDetail(orgId(req), req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Complaint not found' });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

exports.acknowledgeComplaint = async (req, res, next) => {
  try {
    const result = await complaintOps.acknowledgeComplaint(
      orgId(req),
      req.params.id,
      req.user._id,
      req.body?.note
    );
    if (result.error === 'not_found') {
      return res.status(404).json({ success: false, error: 'Complaint not found' });
    }
    if (result.error === 'invalid_status') {
      return res.status(400).json({ success: false, error: 'Complaint cannot be acknowledged in current status' });
    }
    res.json({ success: true, data: result.detail });
  } catch (err) {
    next(err);
  }
};

exports.assignComplaint = async (req, res, next) => {
  try {
    const { assigneeId } = req.body;
    if (!assigneeId) {
      return res.status(400).json({ success: false, error: 'assigneeId is required' });
    }
    const result = await complaintOps.assignComplaint(
      orgId(req),
      req.params.id,
      assigneeId,
      req.user._id
    );
    if (result.error === 'not_found') {
      return res.status(404).json({ success: false, error: 'Complaint not found' });
    }
    res.json({ success: true, data: result.detail });
  } catch (err) {
    next(err);
  }
};

exports.resolveComplaint = async (req, res, next) => {
  try {
    const result = await complaintOps.resolveComplaint(
      orgId(req),
      req.params.id,
      req.user._id,
      req.body?.note
    );
    if (result.error === 'not_found') {
      return res.status(404).json({ success: false, error: 'Complaint not found' });
    }
    res.json({ success: true, data: result.detail });
  } catch (err) {
    next(err);
  }
};

exports.closeComplaint = async (req, res, next) => {
  try {
    const result = await complaintOps.closeComplaint(orgId(req), req.params.id, req.user._id);
    if (result.error === 'not_found') {
      return res.status(404).json({ success: false, error: 'Complaint not found' });
    }
    if (result.error === 'invalid_status') {
      return res.status(400).json({ success: false, error: 'Complaint must be resolved before closing' });
    }
    res.json({ success: true, data: result.detail });
  } catch (err) {
    next(err);
  }
};

// ── Reviews ───────────────────────────────────────────────────────────────────

exports.createReview = async (req, res, next) => {
  try {
    const result = await reviewOps.createReview(orgId(req), req.body);
    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.status(201).json({ success: true, data: result.review });
  } catch (err) {
    next(err);
  }
};

exports.listReviews = async (req, res, next) => {
  try {
    const data = await reviewOps.listReviews(orgId(req), req.query);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// GET /inbox/ops/reviews/by-interaction/:interactionId
exports.getReviewByInteraction = async (req, res, next) => {
  try {
    const data = await reviewOps.getReviewByInteraction(orgId(req), req.params.interactionId);
    if (!data) return res.status(404).json({ success: false, error: 'No review linked to this conversation' });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

exports.getReviewStats = async (req, res, next) => {
  try {
    const data = await reviewOps.getReviewStats(orgId(req));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

exports.getReviewDetail = async (req, res, next) => {
  try {
    const data = await reviewOps.getReviewDetail(orgId(req), req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Review not found' });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

exports.suggestReviewReply = async (req, res, next) => {
  try {
    const interaction = await reviewOps.loadReview(orgId(req), req.params.id);
    if (!interaction) {
      return res.status(404).json({ success: false, error: 'Review not found' });
    }

    const suggestion = await aiService.generateResponse(interaction,orgId(req).toString()
    );

    interaction.aiSuggestion = {
      content: suggestion.content,
      confidence: suggestion.confidence,
      generatedAt: new Date(),
      wasUsed: false
    };
    await interaction.save();
    res.json({ success: true, data: { content: suggestion.content,  confidence: suggestion.confidence }});
  } catch (err) {
    next(err);
  }
};

exports.publishReviewReply = async (req, res, next) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) {
      return res.status(400).json({ success: false, error: 'Reply content is required' });
    }

    const interaction = await Interaction.findById(req.params.id).populate('platformConnection');
    if (!interaction || interaction.organization.toString() !== orgId(req).toString()) {
      return res.status(404).json({ success: false, error: 'Review not found' });
    }
    if (interaction.type !== 'review') {
      return res.status(400).json({ success: false, error: 'Not a review interaction' });
    }

    const connection = await replyService.resolveConnection(interaction);
    const { platformResponseId, status, errorMessage } = await replyService.sendReplyToPlatform({
      interaction,
      connection,
      replyContent: content.trim()
    });

    if (status === 'failed') {
      return res.status(500).json({ success: false, error: errorMessage || 'Failed to publish reply' });
    }

    await interaction.addReply(content.trim(), req.user._id, platformResponseId, false);
    interaction.status = 'replied';
    interaction.metadata = interaction.metadata || {};
    interaction.metadata.reviewReplyPublished = true;
    await interaction.save();

    const detail = await reviewOps.getReviewDetail(orgId(req), req.params.id);
    res.json({ success: true, data: detail, message: 'Reply published' });
  } catch (err) {
    next(err);
  }
};
