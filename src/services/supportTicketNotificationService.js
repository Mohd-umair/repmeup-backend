const emailService = require('./emailService');
const Organization = require('../models/Organization');

const DEFAULT_ADMIN_EMAIL = 'umair9317@gmail.com';

/**
 * Email alert to internal admin when a ticket is created.
 * Failures are logged; never throws to callers.
 */
async function notifyAdminsNewTicket(ticket, raiserUser) {
  const adminEmail = (process.env.ADMIN_SUPPORT_TICKET_EMAIL || DEFAULT_ADMIN_EMAIL).trim();

  let organizationName;
  try {
    if (ticket.organization) {
      const org = await Organization.findById(ticket.organization).select('name').lean();
      organizationName = org?.name;
    }
  } catch (e) {
    console.warn('[supportTicketNotification] Org lookup failed:', e.message);
  }

  try {
    const result = await emailService.sendSupportTicketAdminAlert({
      to: adminEmail,
      ticket,
      raiser: raiserUser,
      organizationName
    });
    if (!result.success) {
      console.error('[supportTicketNotification] email failed:', result.error);
    }
  } catch (err) {
    console.error('[supportTicketNotification] email failed:', err.message || err);
  }
}

module.exports = {
  notifyAdminsNewTicket
};
