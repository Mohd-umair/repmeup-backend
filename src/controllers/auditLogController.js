const AuditLog = require('../models/AuditLog');

/**
 * @desc    List audit logs (filter by entity, date, user)
 * @route   GET /api/audit-logs
 * @access  Private
 */
exports.getAuditLogs = async (req, res) => {
  try {
    const organizationId = req.user.organization?._id || req.user.organization;
    const { entity, entityId, action, userId, startDate, endDate, limit = 50 } = req.query;

    const filter = { organization: organizationId };
    if (entity) filter.entity = entity;
    if (entityId) filter.entityId = entityId;
    if (action) filter.action = action;
    if (userId) filter.userId = userId;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const logs = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(parseInt(limit, 10) || 50, 100))
      .populate('userId', 'name email')
      .lean();

    res.status(200).json({
      success: true,
      data: logs,
      count: logs.length
    });
  } catch (error) {
    console.error('Get audit logs error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Helper to write an audit log entry (call from controllers).
 */
exports.log = async (organizationId, entity, entityId, action, userId, metadata = {}) => {
  try {
    await AuditLog.create({
      organization: organizationId,
      entity,
      entityId: entityId ? String(entityId) : undefined,
      action,
      userId,
      metadata
    });
  } catch (err) {
    console.warn('[AuditLog] log failed:', err.message);
  }
};
