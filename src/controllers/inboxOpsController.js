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

exports.updateOrderStatus = async (req, res, next) => {
  try {
    const { status, notes } = req.body;
    const result = await orderOps.updateOrderStatus(orgId(req), req.params.id, status, notes);
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

exports.listReviews = async (req, res, next) => {
  try {
    const data = await reviewOps.listReviews(orgId(req), req.query);
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

    const suggestion = await aiService.generateResponse(
      interaction,
      orgId(req).toString()
    );

    interaction.aiSuggestion = {
      content: suggestion.content,
      confidence: suggestion.confidence,
      generatedAt: new Date(),
      wasUsed: false
    };
    await interaction.save();

    res.json({
      success: true,
      data: {
        content: suggestion.content,
        confidence: suggestion.confidence
      }
    });
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
