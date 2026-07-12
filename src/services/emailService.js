const nodemailer = require('nodemailer');
const {
  buildWelcomeSignupEmail,
  buildWelcomeSignupPlainText
} = require('./emailTemplates/welcomeSignupTemplate');

/** Avoid 535 from accidental spaces/newlines when pasting into .env */
function smtpEnv(name, fallback = '') {
  const v = process.env[name];
  if (v == null) return fallback;
  return String(v).trim();
}

/** Plain transactional emails: white page background for all clients */
function wrapSimpleEmailHtml(innerHtml) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background-color:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111827;">
${innerHtml}
</body>
</html>`;
}

class EmailService {
  constructor() {
    this.transporter = null;
    this.initializeTransporter();
  }

  initializeTransporter() {
    const host = smtpEnv('SMTP_HOST', 'smtpout.secureserver.net');
    const port = parseInt(smtpEnv('SMTP_PORT', '465'), 10) || 465;
    const user = smtpEnv('SMTP_USER');
    const pass = smtpEnv('SMTP_PASS');

    if (!user || !pass) {
      console.warn('[emailService] SMTP_USER or SMTP_PASS is empty — sending mail will fail until both are set.');
    }

    const auth = { user, pass };

    // Allow overriding auth method via env (LOGIN, PLAIN, etc.). Some GoDaddy /
    // Microsoft 365 servers accept AUTH LOGIN but reject AUTH PLAIN.
    const authMethod = smtpEnv('SMTP_AUTH_METHOD').toUpperCase();
    if (authMethod) auth.method = authMethod;

    // Port 465 = implicit TLS (secure); 587/25 = plain socket then STARTTLS.
    // SMTP_SECURE=true|false overrides the port-based default when needed.
    const secureEnv = smtpEnv('SMTP_SECURE').toLowerCase();
    const secure = secureEnv ? secureEnv === 'true' : port === 465;

    const options = {
      host,
      port,
      auth,
      secure,
      requireTLS: !secure // force STARTTLS on 587/25
    };

    // Legacy SSLv3 cipher pinning is ONLY needed by GoDaddy's old Workspace Email
    // (smtpout.secureserver.net). Forcing it on Microsoft 365 (smtp.office365.com)
    // breaks the TLS handshake, so only apply it for the legacy host — or when
    // explicitly opted in with SMTP_LEGACY_CIPHERS=true.
    const legacyCiphers =
      smtpEnv('SMTP_LEGACY_CIPHERS') === 'true' || /secureserver\.net$/i.test(host);
    if (legacyCiphers) {
      options.tls = { ciphers: 'SSLv3' };
    }

    if (smtpEnv('SMTP_DEBUG') === 'true') {
      options.debug = true;
      options.logger = true;
    }

    this.transporter = nodemailer.createTransport(options);
  }

  /**
   * Send email
   */
  async sendEmail({ to, subject, html, text }) {
    try {
      const mailOptions = {
        from: `${process.env.FROM_NAME || 'ORM System'} <${process.env.FROM_EMAIL || 'noreply@orm.com'}>`,
        to,
        subject,
        html,
        text: text || html.replace(/<[^>]*>/g, '') // Strip HTML for text version
      };

      const info = await this.transporter.sendMail(mailOptions);

      console.log('Email sent:', info.messageId);
      
      if (process.env.NODE_ENV === 'development') {
        console.log('Preview URL:', nodemailer.getTestMessageUrl(info));
      }

      return {
        success: true,
        messageId: info.messageId
      };
    } catch (error) {
      console.error('Email send error:', error);
      if (error.code === 'EAUTH' || String(error.message || '').includes('535')) {
        console.error(
          '[emailService] SMTP login rejected (535). Checklist:\n' +
            '  1) Verify you can log into GoDaddy webmail (https://email.secureserver.net) with the SAME user/password\n' +
            '  2) SMTP_HOST must be smtpout.secureserver.net for GoDaddy email\n' +
            '  3) SMTP_USER = full email address (e.g. info@repmeup.in)\n' +
            '  4) Password in .env with special chars (#$!) → wrap in single quotes: SMTP_PASS=\'pass#here\'\n' +
            '  5) Try SMTP_PORT=587 if 465 fails (or vice versa)\n' +
            '  6) SMTP_DEBUG=true for verbose SMTP trace'
        );
      }
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send email-verification link after email/password registration.
   */
  async sendEmailVerificationEmail(user, rawToken) {
    const baseUrl = String(process.env.FRONTEND_URL || 'http://localhost:4200').replace(/\/$/, '');
    const verifyUrl = `${baseUrl}/auth/verify-email?token=${encodeURIComponent(rawToken)}`;
    const expiryHours =
      Math.round((parseInt(process.env.EMAIL_VERIFICATION_EXPIRY_MS || '', 10) || 48 * 60 * 60 * 1000) / (60 * 60 * 1000)) ||
      48;
    const appName = process.env.APP_PUBLIC_NAME || process.env.FROM_NAME || 'RepMeUp';

    const subject = `Verify your email for ${appName}`;
    const html = `
      <!DOCTYPE html>
      <html>
      <body style="margin:0;padding:0;background-color:#ffffff;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;padding:40px 20px;">
          <tr>
            <td align="center">
              <table width="520" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
                <tr>
                  <td style="background-color:#ffffff;padding:32px;text-align:center;border-bottom:3px solid #c8f135;">
                    <span style="font-size:28px;font-weight:900;color:#c8f135;letter-spacing:-1px;">${appName}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:40px 36px;">
                    <h2 style="margin:0 0 8px;font-size:22px;color:#0a0a0a;">Confirm your email</h2>
                    <p style="margin:0 0 24px;color:#555;font-size:15px;">Hi ${user.firstName},</p>
                    <p style="margin:0 0 28px;color:#555;font-size:15px;line-height:1.6;">
                      Thanks for signing up. Please verify your email address to activate your account. This link expires in <strong>${expiryHours} hours</strong>.
                    </p>
                    <table cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td align="center">
                          <a href="${verifyUrl}"
                            style="display:inline-block;background-color:#c8f135;color:#0a0a0a;font-weight:700;font-size:16px;text-decoration:none;padding:14px 40px;border-radius:10px;">
                            Verify email
                          </a>
                        </td>
                      </tr>
                    </table>
                    <p style="margin:28px 0 0;color:#888;font-size:13px;line-height:1.6;">
                      If the button doesn't work, copy and paste this link into your browser:<br>
                      <a href="${verifyUrl}" style="color:#c8f135;word-break:break-all;">${verifyUrl}</a>
                    </p>
                    <hr style="border:none;border-top:1px solid #eee;margin:28px 0;">
                    <p style="margin:0;color:#aaa;font-size:13px;">
                      If you didn't create an account, you can ignore this email.
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="background-color:#f9f9f9;padding:20px 36px;text-align:center;border-top:1px solid #eee;">
                    <p style="margin:0;color:#aaa;font-size:12px;">© ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    const text = `Hi ${user.firstName},\n\nVerify your email for ${appName} by opening this link (expires in ${expiryHours} hours):\n${verifyUrl}\n\nIf you didn't sign up, ignore this email.\n`;

    return this.sendEmail({
      to: user.email,
      subject,
      html,
      text
    });
  }

  /**
   * Send welcome email (first-time signup: register, Google OAuth, or team invite with temp password).
   */
  async sendWelcomeEmail(user, tempPassword = null) {
    const baseUrl = String(process.env.FRONTEND_URL || 'http://localhost:4200').replace(/\/$/, '');
    const appName = process.env.APP_PUBLIC_NAME || process.env.FROM_NAME || 'RepMeUp';
    const loginUrl = `${baseUrl}/auth/login`;
    const dashboardUrl = `${baseUrl}/app/dashboard`;

    const html = buildWelcomeSignupEmail({
      firstName: user.firstName,
      tempPassword: tempPassword || null,
      loginUrl,
      dashboardUrl,
      appName
    });
    const text = buildWelcomeSignupPlainText({
      firstName: user.firstName,
      tempPassword: tempPassword || null,
      loginUrl,
      dashboardUrl,
      appName
    });
    const subject = `Welcome to ${appName} — your account is ready`;

    return this.sendEmail({
      to: user.email,
      subject,
      html,
      text
    });
  }

  /**
   * Send assignment notification
   */
  async sendAssignmentNotification(user, interaction) {
    const subject = `New ${interaction.type} assigned to you`;
    const html = wrapSimpleEmailHtml(`
      <h2>New Assignment</h2>
      <p>Hi ${user.firstName},</p>
      <p>A new ${interaction.type} from ${interaction.platform} has been assigned to you.</p>
      <blockquote>${interaction.content}</blockquote>
      <p>Author: ${interaction.author.name || 'Unknown'}</p>
      <p>Sentiment: ${interaction.sentiment || 'Not analyzed'}</p>
      <p><a href="${process.env.FRONTEND_URL}/inbox/${interaction._id}">View and respond</a></p>
      <p>Best regards,<br>ORM System</p>
    `);

    return this.sendEmail({
      to: user.email,
      subject,
      html
    });
  }

  /**
   * Send negative spike alert
   */
  async sendNegativeSpikeAlert(user, postId, count) {
    const subject = `Alert: ${count} negative comments detected`;
    const html = wrapSimpleEmailHtml(`
      <h2>Negative Comment Alert</h2>
      <p>Hi ${user.firstName},</p>
      <p><strong>Alert:</strong> ${count} negative comments have been detected on a single post.</p>
      <p>This requires immediate attention.</p>
      <p><a href="${process.env.FRONTEND_URL}/inbox?postId=${postId}">View comments</a></p>
      <p>Best regards,<br>ORM System</p>
    `);

    return this.sendEmail({
      to: user.email,
      subject,
      html
    });
  }

  /**
   * Send daily digest
   */
  async sendDailyDigest(user, stats) {
    const subject = 'Your Daily ORM Digest';
    const html = wrapSimpleEmailHtml(`
      <h2>Daily Digest for ${new Date().toLocaleDateString()}</h2>
      <p>Hi ${user.firstName},</p>
      <h3>Today's Summary:</h3>
      <ul>
        <li>Total Interactions: ${stats.total || 0}</li>
        <li>New Comments: ${stats.comments || 0}</li>
        <li>New DMs: ${stats.dms || 0}</li>
        <li>New Reviews: ${stats.reviews || 0}</li>
        <li>Positive: ${stats.positive || 0}</li>
        <li>Negative: ${stats.negative || 0}</li>
        <li>Unread: ${stats.unread || 0}</li>
      </ul>
      <p><a href="${process.env.FRONTEND_URL}/inbox">View all interactions</a></p>
      <p>Best regards,<br>ORM System</p>
    `);

    return this.sendEmail({
      to: user.email,
      subject,
      html
    });
  }

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(user, resetToken) {
    const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password?token=${resetToken}`;
    const subject = 'Reset Your RepMeUp Password';
    const html = `
      <!DOCTYPE html>
      <html>
      <body style="margin:0;padding:0;background-color:#ffffff;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;padding:40px 20px;">
          <tr>
            <td align="center">
              <table width="520" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
                <!-- Header -->
                <tr>
                  <td style="background-color:#ffffff;padding:32px;text-align:center;border-bottom:3px solid #c8f135;">
                    <span style="font-size:28px;font-weight:900;color:#c8f135;letter-spacing:-1px;">RepMeUp</span>
                  </td>
                </tr>
                <!-- Body -->
                <tr>
                  <td style="padding:40px 36px;">
                    <h2 style="margin:0 0 8px;font-size:22px;color:#0a0a0a;">Reset Your Password</h2>
                    <p style="margin:0 0 24px;color:#555;font-size:15px;">Hi ${user.firstName},</p>
                    <p style="margin:0 0 28px;color:#555;font-size:15px;line-height:1.6;">
                      We received a request to reset the password for your RepMeUp account. Click the button below to set a new password. This link expires in <strong>1 hour</strong>.
                    </p>
                    <table cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td align="center">
                          <a href="${resetUrl}"
                            style="display:inline-block;background-color:#c8f135;color:#0a0a0a;font-weight:700;font-size:16px;text-decoration:none;padding:14px 40px;border-radius:10px;">
                            Reset Password
                          </a>
                        </td>
                      </tr>
                    </table>
                    <p style="margin:28px 0 0;color:#888;font-size:13px;line-height:1.6;">
                      If the button doesn't work, copy and paste this link into your browser:<br>
                      <a href="${resetUrl}" style="color:#c8f135;word-break:break-all;">${resetUrl}</a>
                    </p>
                    <hr style="border:none;border-top:1px solid #eee;margin:28px 0;">
                    <p style="margin:0;color:#aaa;font-size:13px;">
                      If you didn't request a password reset, you can safely ignore this email. Your password will not be changed.
                    </p>
                  </td>
                </tr>
                <!-- Footer -->
                <tr>
                  <td style="background-color:#f9f9f9;padding:20px 36px;text-align:center;border-top:1px solid #eee;">
                    <p style="margin:0;color:#aaa;font-size:12px;">© ${new Date().getFullYear()} RepMeUp. All rights reserved.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    return this.sendEmail({
      to: user.email,
      subject,
      html
    });
  }

  /**
   * Send a 6-digit OTP for passwordless login.
   */
  async sendLoginOtpEmail(email, otp, firstName) {
    const displayName = firstName || email.split('@')[0];
    const subject = `${otp} — Your RepMeUp login code`;
    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"></head>
      <body style="margin:0;padding:0;background-color:#0a0a0a;font-family:Arial,Helvetica,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center" style="padding:40px 20px;">
              <table width="520" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:16px;overflow:hidden;">
                <!-- Header -->
                <tr>
                  <td style="background-color:#0a0a0a;padding:32px 36px;text-align:center;">
                    <div style="display:inline-block;background-color:#c8f135;padding:12px 24px;border-radius:10px;">
                      <span style="font-size:20px;font-weight:900;color:#0a0a0a;letter-spacing:-0.5px;">RepMeUp</span>
                    </div>
                  </td>
                </tr>
                <!-- Body -->
                <tr>
                  <td style="padding:36px 36px 28px;">
                    <h2 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0a0a0a;">Your login code</h2>
                    <p style="margin:0 0 28px;color:#555;font-size:15px;line-height:1.6;">
                      Hi ${displayName}, use the code below to sign in to RepMeUp. This code expires in <strong>10 minutes</strong>.
                    </p>
                    <!-- OTP Box -->
                    <div style="background-color:#f4f4f4;border:2px solid #c8f135;border-radius:14px;padding:28px;text-align:center;margin-bottom:28px;">
                      <span style="font-size:48px;font-weight:900;letter-spacing:16px;color:#0a0a0a;font-family:'Courier New',monospace;">${otp}</span>
                    </div>
                    <p style="margin:0;color:#888;font-size:13px;line-height:1.6;">
                      If you didn't request this code, you can safely ignore this email. Someone may have typed your email by mistake.
                    </p>
                    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
                    <p style="margin:0;color:#aaa;font-size:12px;">
                      For security, never share this code with anyone — RepMeUp will never ask for it.
                    </p>
                  </td>
                </tr>
                <!-- Footer -->
                <tr>
                  <td style="background-color:#f9f9f9;padding:16px 36px;text-align:center;border-top:1px solid #eee;">
                    <p style="margin:0;color:#aaa;font-size:12px;">© ${new Date().getFullYear()} RepMeUp. All rights reserved.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    return this.sendEmail({ to: email, subject, html });
  }

  /**
   * Notify internal admin inbox when a user raises a support ticket.
   */
  async sendSupportTicketAdminAlert({ to, ticket, raiser, organizationName }) {
    const esc = (v) =>
      String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const appName = process.env.APP_PUBLIC_NAME || process.env.FROM_NAME || 'RepMeUp';
    const safeOrg = esc(organizationName || '—');
    const raiserName = esc(
      raiser
        ? `${raiser.firstName || ''} ${raiser.lastName || ''}`.trim() || raiser.email
        : 'Unknown'
    );
    const raiserEmail = esc(raiser?.email || '—');
    const descPreview =
      ticket.description.length > 2000
        ? `${ticket.description.slice(0, 2000)}…`
        : ticket.description;
    const descHtml = esc(descPreview);

    const subject = `[${appName}] New ticket: ${ticket.subject}`;
    const html = wrapSimpleEmailHtml(`
      <h2>New support ticket</h2>
      <p><strong>Ticket ID:</strong> ${ticket._id}</p>
      <p><strong>Subject:</strong> ${esc(ticket.subject)}</p>
      <p><strong>Category:</strong> ${esc(ticket.category)}</p>
      <p><strong>Priority:</strong> ${esc(ticket.priority)}</p>
      <p><strong>Organization:</strong> ${safeOrg}</p>
      <p><strong>Raised by:</strong> ${raiserName} &lt;${raiserEmail}&gt;</p>
      <h3>Description</h3>
      <pre style="white-space:pre-wrap;font-family:inherit;background:#f3f4f6;padding:12px;border-radius:8px;">${descHtml}</pre>
      <p style="color:#6b7280;font-size:13px;">Reply in the admin panel or your ticket workflow.</p>
    `);

    const text = [
      `New support ticket (${appName})`,
      `ID: ${ticket._id}`,
      `Subject: ${ticket.subject}`,
      `Category: ${ticket.category}`,
      `Priority: ${ticket.priority}`,
      `Organization: ${safeOrg}`,
      `Raised by: ${raiserName} <${raiserEmail}>`,
      '',
      ticket.description
    ].join('\n');

    return this.sendEmail({ to, subject, html, text });
  }

  /**
   * Notify sales when someone books a product demo from the marketing site.
   */
  async sendDemoBookingAlert({ to, inquiry }) {
    const esc = (v) =>
      String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const appName = process.env.APP_PUBLIC_NAME || process.env.FROM_NAME || 'RepMeUp';

    const subject = `[${appName}] New demo booking — ${inquiry.name}${inquiry.company ? ` (${inquiry.company})` : ''}`;
    const html = wrapSimpleEmailHtml(`
      <h2>New demo booking</h2>
      <p><strong>Name:</strong> ${esc(inquiry.name)}</p>
      <p><strong>Email:</strong> <a href="mailto:${esc(inquiry.email)}">${esc(inquiry.email)}</a></p>
      <p><strong>Phone:</strong> ${esc(inquiry.phone || '—')}</p>
      <p><strong>Company:</strong> ${esc(inquiry.company || '—')}</p>
      ${inquiry.teamSize ? `<p><strong>Team size:</strong> ${esc(inquiry.teamSize)}</p>` : ''}
      <p><strong>Preferred date:</strong> ${esc(inquiry.demoDate)}</p>
      <p><strong>Preferred time:</strong> ${esc(inquiry.demoTime)} (${esc(inquiry.timezone || 'Asia/Kolkata')})</p>
      ${inquiry.notes ? `<h3>Notes</h3><pre style="white-space:pre-wrap;font-family:inherit;background:#f3f4f6;padding:12px;border-radius:8px;">${esc(inquiry.notes)}</pre>` : ''}
      <p style="color:#6b7280;font-size:13px;margin-top:24px;">Submitted from repmeup.in/book-demo</p>
    `);

    const text = [
      `New demo booking (${appName})`,
      `Name: ${inquiry.name}`,
      `Email: ${inquiry.email}`,
      `Phone: ${inquiry.phone || '—'}`,
      `Company: ${inquiry.company || '—'}`,
      inquiry.teamSize ? `Team size: ${inquiry.teamSize}` : null,
      `Date: ${inquiry.demoDate}`,
      `Time: ${inquiry.demoTime} (${inquiry.timezone || 'Asia/Kolkata'})`,
      inquiry.notes ? `\nNotes:\n${inquiry.notes}` : null
    ]
      .filter(Boolean)
      .join('\n');

    return this.sendEmail({ to, subject, html, text });
  }
}

module.exports = new EmailService();

