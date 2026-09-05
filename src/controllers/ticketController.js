const path = require('path');
const storageService = require('../services/storageService');
const supportTicketNotificationService = require('../services/supportTicketNotificationService');
const SupportTicket = require('../models/SupportTicket');

// ─── User-facing handlers ────────────────────────────────────────────────────

/**
 * @desc    Raise a new support ticket
 * @route   POST /api/tickets
 * @access  Private
 */
exports.raiseTicket = async (req, res, next) => {
  try {
    const { subject, category, description, priority } = req.body;

    if (!subject || !category || !description) {
      return res.status(400).json({
        success: false,
        error: 'subject, category and description are required'
      });
    }

    const validCategories = ['bug', 'feature_request', 'billing', 'general'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({ success: false, error: 'Invalid category' });
    }

    const validPriorities = ['low', 'medium', 'high'];
    if (priority && !validPriorities.includes(priority)) {
      return res.status(400).json({ success: false, error: 'Invalid priority' });
    }

    const organizationId = req.user.organization?._id || req.user.organization;

    const ticket = await SupportTicket.create({
      organization: organizationId,
      raisedBy: req.user._id,
      subject: subject.trim(),
      category,
      description: description.trim(),
      priority: priority || 'medium',
      status: 'open'
    });

    supportTicketNotificationService
      .notifyAdminsNewTicket(ticket, req.user)
      .catch((err) => console.error('[ticket] Admin notification error:', err));

    res.status(201).json({ success: true, data: ticket });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Get current user's tickets (paginated)
 * @route   GET /api/tickets
 * @access  Private
 */
exports.getMyTickets = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter = { raisedBy: req.user._id };

    const status = req.query.status;
    if (status && ['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
      filter.status = status;
    }

    const category = req.query.category;
    if (category && ['bug', 'feature_request', 'billing', 'general'].includes(category)) {
      filter.category = category;
    }

    const priority = req.query.priority;
    if (priority && ['low', 'medium', 'high'].includes(priority)) {
      filter.priority = priority;
    }

    const rawQ = String(req.query.q || req.query.search || '')
      .trim()
      .slice(0, 200);
    if (rawQ.length > 0) {
      const escaped = rawQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { subject: { $regex: escaped, $options: 'i' } },
        { description: { $regex: escaped, $options: 'i' } }
      ];
    }

    const [tickets, total] = await Promise.all([
      SupportTicket.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      SupportTicket.countDocuments(filter)
    ]);

    res.status(200).json({
      success: true,
      data: {
        tickets,
        pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 }
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Get a single ticket (own only unless super-admin)
 * @route   GET /api/tickets/:id
 * @access  Private
 */
exports.getTicket = async (req, res, next) => {
  try {
    const ticket = await SupportTicket.findById(req.params.id)
      .populate('raisedBy', 'firstName lastName email')
      .lean();

    if (!ticket) {
      return res.status(404).json({ success: false, error: 'Ticket not found' });
    }

    const isSuperAdmin = req.user.role === 'super_admin';
    const isOwner = ticket.raisedBy?._id?.toString() === req.user._id.toString();

    if (!isSuperAdmin && !isOwner) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    res.status(200).json({ success: true, data: ticket });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Upload an attachment for a ticket
 * @route   POST /api/tickets/:id/attachments
 * @access  Private
 */
exports.uploadAttachment = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) {
      return res.status(404).json({ success: false, error: 'Ticket not found' });
    }

    const isOwner = ticket.raisedBy.toString() === req.user._id.toString();
    const isSuperAdmin = req.user.role === 'super_admin';
    if (!isOwner && !isSuperAdmin) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const file = req.file;
    const organizationId = req.user.organization?._id || req.user.organization;
    let publicUrl;

    if (storageService.isS3Configured()) {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname) || '';
      const filename = `ticket-${uniqueSuffix}${ext}`;
      const key = storageService.buildPostsKey(organizationId, filename);
      if (!file.buffer) {
        return res.status(500).json({ success: false, error: 'Upload buffer missing' });
      }
      const uploaded = await storageService.uploadBuffer(key, file.buffer, file.mimetype);
      publicUrl = uploaded.publicUrl;
    } else {
      const baseUrl = (process.env.BASE_URL || 'https://repmeup.in').replace(/\/api\/?$/, '');
      publicUrl = `${baseUrl}/api/posts/media/${file.filename}`;
    }

    const attachment = { url: publicUrl, name: file.originalname, type: file.mimetype };
    ticket.attachments.push(attachment);
    await ticket.save();

    res.status(200).json({ success: true, data: attachment });
  } catch (err) {
    next(err);
  }
};

// ─── Super-admin handlers ─────────────────────────────────────────────────────

/**
 * @desc    List all tickets (super-admin), filterable by status/org/priority
 * @route   GET /api/super-admin/tickets
 * @access  Super Admin
 */
exports.superAdminListTickets = async (req, res, next) => {
  try {
    const { status, priority, organizationId, search } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (organizationId) filter.organization = organizationId;
    if (search) {
      filter.$or = [
        { subject: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    const [tickets, total] = await Promise.all([
      SupportTicket.find(filter)
        .sort({ createdAt: -1 })
        .limit(500)
        .populate('raisedBy', 'firstName lastName email')
        .populate('organization', 'name')
        .lean(),
      SupportTicket.countDocuments(filter)
    ]);

    // Return grouped Kanban format
    const kanban = { open: [], in_progress: [], resolved: [], closed: [] };
    for (const t of tickets) {
      if (kanban[t.status]) kanban[t.status].push(t);
    }

    res.status(200).json({
      success: true,
      data: { ...kanban, total }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Update ticket status and optional admin notes (super-admin)
 * @route   PATCH /api/super-admin/tickets/:id/status
 * @access  Super Admin
 */
exports.superAdminUpdateStatus = async (req, res, next) => {
  try {
    const { status, adminNotes } = req.body;

    const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }

    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) {
      return res.status(404).json({ success: false, error: 'Ticket not found' });
    }

    ticket.status = status;
    if (adminNotes !== undefined) ticket.adminNotes = adminNotes;
    if (status === 'resolved' && !ticket.resolvedAt) {
      ticket.resolvedAt = new Date();
    }
    if (status !== 'resolved') {
      ticket.resolvedAt = null;
    }

    await ticket.save();

    res.status(200).json({ success: true, data: ticket });
  } catch (err) {
    next(err);
  }
};
