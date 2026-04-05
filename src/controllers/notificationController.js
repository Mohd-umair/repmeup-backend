const Notification = require('../models/Notification');

/**
 * @desc    Get user notifications
 * @route   GET /api/notifications
 * @access  Private
 */
exports.getNotifications = async (req, res, next) => {
  try {
    const { unreadOnly, limit = 50, page = 1 } = req.query;
    const skip = (page - 1) * limit;

    const query = {
      user: req.user._id,
      organization: req.user.organization._id
    };

    if (unreadOnly === 'true') {
      query.isRead = false;
    }

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .limit(parseInt(limit))
        .skip(skip),
      Notification.countDocuments(query),
      Notification.countDocuments({
        user: req.user._id,
        organization: req.user.organization._id,
        isRead: false
      })
    ]);

    res.status(200).json({
      success: true,
      data: notifications,
      unreadCount,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    next(error);
  }
};

/** Notification types that belong to the Inbox (social interactions). */
const INBOX_TYPES = ['new_interaction', 'assignment', 'mention', 'escalation', 'response_received'];
/** Notification types that belong to the Publish workflow (post review). */
const PUBLISH_TYPES = ['post_pending_approval', 'post_approved', 'post_rejected'];

/**
 * @desc    Get unread notification count split by UI section
 * @route   GET /api/notifications/unread-count
 * @access  Private
 */
exports.getUnreadCount = async (req, res, next) => {
  try {
    const base = {
      user: req.user._id,
      organization: req.user.organization._id,
      isRead: false
    };

    const [total, inboxCount, publishCount] = await Promise.all([
      Notification.countDocuments(base),
      Notification.countDocuments({ ...base, type: { $in: INBOX_TYPES } }),
      Notification.countDocuments({ ...base, type: { $in: PUBLISH_TYPES } })
    ]);

    res.status(200).json({
      success: true,
      data: { count: total, inboxCount, publishCount }
    });
  } catch (error) {
    console.error('Get unread count error:', error);
    next(error);
  }
};

/**
 * @desc    Mark notification as read
 * @route   PUT /api/notifications/:id/read
 * @access  Private
 */
exports.markAsRead = async (req, res, next) => {
  try {
    const notification = await Notification.findOne({
      _id: req.params.id,
      user: req.user._id
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        error: 'Notification not found'
      });
    }

    await notification.markAsRead();

    res.status(200).json({
      success: true,
      data: notification
    });
  } catch (error) {
    console.error('Mark notification as read error:', error);
    next(error);
  }
};

/**
 * @desc    Mark all notifications as read
 * @route   PUT /api/notifications/mark-all-read
 * @access  Private
 */
exports.markAllAsRead = async (req, res, next) => {
  try {
    await Notification.updateMany(
      {
        user: req.user._id,
        organization: req.user.organization._id,
        isRead: false
      },
      {
        $set: {
          isRead: true,
          readAt: new Date()
        }
      }
    );

    res.status(200).json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    console.error('Mark all as read error:', error);
    next(error);
  }
};

/**
 * @desc    Delete notification
 * @route   DELETE /api/notifications/:id
 * @access  Private
 */
exports.deleteNotification = async (req, res, next) => {
  try {
    const notification = await Notification.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        error: 'Notification not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Notification deleted'
    });
  } catch (error) {
    console.error('Delete notification error:', error);
    next(error);
  }
};

/**
 * @desc    Delete all read notifications
 * @route   DELETE /api/notifications/clear-read
 * @access  Private
 */
exports.clearReadNotifications = async (req, res, next) => {
  try {
    const result = await Notification.deleteMany({
      user: req.user._id,
      organization: req.user.organization._id,
      isRead: true
    });

    res.status(200).json({
      success: true,
      message: `${result.deletedCount} notification(s) cleared`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Clear read notifications error:', error);
    next(error);
  }
};
