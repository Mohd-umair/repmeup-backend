const ContactInquiry = require('../models/ContactInquiry');
const userActivityLogService = require('../services/userActivityLogService');
const leadCaptureService = require('../services/crm/leadCaptureService');
const { sanitizeString, escapeRegex } = require('../utils/sanitize');

/**
 * POST /api/contact/submit — public marketing contact form
 */
exports.submit = async (req, res, next) => {
  try {
    const { name, email, phone, company, subject, message, intent } = req.body;

    const inquiry = await ContactInquiry.create({
      name: sanitizeString(name, { maxLength: 200 }),
      email: sanitizeString(email, { maxLength: 320 }).toLowerCase(),
      phone: sanitizeString(phone || '', { maxLength: 40 }),
      company: sanitizeString(company || '', { maxLength: 200 }),
      subject: sanitizeString(subject, { maxLength: 80 }),
      message: sanitizeString(message, { maxLength: 10000 }),
      intent: intent ? sanitizeString(intent, { maxLength: 64 }) : undefined,
      source: 'website',
      ip: userActivityLogService.clientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 500)
    });

    // Fire-and-forget: the public form must never fail on CRM issues
    leadCaptureService.captureFromContactInquiry(inquiry).catch((err) => {
      console.error('[contactInquiry] CRM lead capture failed:', err?.message || err);
    });

    res.status(201).json({
      success: true,
      message: 'Thank you — we received your message.'
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/super-admin/contact-inquiries — panel list (JWT + super_admin|admin)
 */
exports.listForSuperAdmin = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.search && String(req.query.search).trim()) {
      const q = escapeRegex(String(req.query.search).trim().slice(0, 100));
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { email: { $regex: q, $options: 'i' } },
        { company: { $regex: q, $options: 'i' } },
        { message: { $regex: q, $options: 'i' } }
      ];
    }
    if (req.query.subject && String(req.query.subject).trim()) {
      filter.subject = String(req.query.subject).trim();
    }

    const [items, total] = await Promise.all([
      ContactInquiry.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ContactInquiry.countDocuments(filter)
    ]);

    res.status(200).json({
      success: true,
      data: {
        items,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit) || 0
        }
      }
    });
  } catch (err) {
    next(err);
  }
};
