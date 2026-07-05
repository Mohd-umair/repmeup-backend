const ContactInquiry = require('../models/ContactInquiry');
const emailService = require('../services/emailService');
const userActivityLogService = require('../services/userActivityLogService');
const leadCaptureService = require('../services/crm/leadCaptureService');
const { sanitizeString } = require('../utils/sanitize');

const DEMO_RECIPIENT = () =>
  String(process.env.DEMO_BOOKING_EMAIL || 'info@repmeup.in').trim().toLowerCase();

/**
 * POST /api/demo/book — public demo booking form
 */
exports.book = async (req, res, next) => {
  try {
    const {
      name,
      email,
      phone,
      company,
      demoDate,
      demoTime,
      timezone,
      teamSize,
      notes
    } = req.body;

    const safeName = sanitizeString(name, { maxLength: 200 });
    const safeEmail = sanitizeString(email, { maxLength: 320 }).toLowerCase();
    const safePhone = sanitizeString(phone || '', { maxLength: 40 });
    const safeCompany = sanitizeString(company || '', { maxLength: 200 });
    const safeDate = sanitizeString(demoDate, { maxLength: 10 });
    const safeTime = sanitizeString(demoTime, { maxLength: 20 });
    const safeTz = sanitizeString(timezone || 'Asia/Kolkata', { maxLength: 64 });
    const safeTeamSize = sanitizeString(teamSize || '', { maxLength: 40 });
    const safeNotes = sanitizeString(notes || '', { maxLength: 5000 });

    const messageParts = [
      `Preferred demo: ${safeDate} at ${safeTime} (${safeTz})`,
      safeTeamSize ? `Team size: ${safeTeamSize}` : null,
      safeNotes ? `Notes: ${safeNotes}` : null
    ].filter(Boolean);

    const inquiry = await ContactInquiry.create({
      name: safeName,
      email: safeEmail,
      phone: safePhone,
      company: safeCompany,
      subject: 'demo',
      message: messageParts.join('\n'),
      intent: 'book-demo',
      demoDate: safeDate,
      demoTime: safeTime,
      timezone: safeTz,
      source: 'book-demo',
      ip: userActivityLogService.clientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 500)
    });

    // Fire-and-forget: the public booking must never fail on CRM issues
    leadCaptureService.captureFromDemoBooking(inquiry).catch((err) => {
      console.error('[demoBooking] CRM lead capture failed:', err?.message || err);
    });

    emailService
      .sendDemoBookingAlert({
        to: DEMO_RECIPIENT(),
        inquiry: {
          ...inquiry.toObject(),
          teamSize: safeTeamSize,
          notes: safeNotes
        }
      })
      .catch((err) => {
        console.error('[demoBooking] Failed to send alert email:', err?.message || err);
      });

    res.status(201).json({
      success: true,
      message: 'Your demo has been scheduled. We will confirm by email shortly.'
    });
  } catch (err) {
    next(err);
  }
};
