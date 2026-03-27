const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    this.transporter = null;
    this.initializeTransporter();
  }

  initializeTransporter() {
    const port = parseInt(process.env.SMTP_PORT || '465', 10);
    // Titan Email: smtp.titan.email — 465 (SSL) or 587 (STARTTLS). See env-example.txt.
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.titan.email',
      port,
      secure: port === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
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
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send welcome email
   */
  async sendWelcomeEmail(user, tempPassword = null) {
    const subject = 'Welcome to ORM System';
    const html = `
      <h1>Welcome to ORM System, ${user.firstName}!</h1>
      <p>Your account has been created successfully.</p>
      ${tempPassword ? `<p><strong>Temporary Password:</strong> ${tempPassword}</p>
      <p>Please change your password after your first login.</p>` : ''}
      <p>Get started by connecting your social media accounts and managing all your interactions in one place.</p>
      <p>Best regards,<br>ORM Team</p>
    `;

    return this.sendEmail({
      to: user.email,
      subject,
      html
    });
  }

  /**
   * Send assignment notification
   */
  async sendAssignmentNotification(user, interaction) {
    const subject = `New ${interaction.type} assigned to you`;
    const html = `
      <h2>New Assignment</h2>
      <p>Hi ${user.firstName},</p>
      <p>A new ${interaction.type} from ${interaction.platform} has been assigned to you.</p>
      <blockquote>${interaction.content}</blockquote>
      <p>Author: ${interaction.author.name || 'Unknown'}</p>
      <p>Sentiment: ${interaction.sentiment || 'Not analyzed'}</p>
      <p><a href="${process.env.FRONTEND_URL}/inbox/${interaction._id}">View and respond</a></p>
      <p>Best regards,<br>ORM System</p>
    `;

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
    const html = `
      <h2>Negative Comment Alert</h2>
      <p>Hi ${user.firstName},</p>
      <p><strong>Alert:</strong> ${count} negative comments have been detected on a single post.</p>
      <p>This requires immediate attention.</p>
      <p><a href="${process.env.FRONTEND_URL}/inbox?postId=${postId}">View comments</a></p>
      <p>Best regards,<br>ORM System</p>
    `;

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
    const html = `
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
    `;

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
      <body style="margin:0;padding:0;background-color:#0a0a0a;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0a;padding:40px 20px;">
          <tr>
            <td align="center">
              <table width="520" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:16px;overflow:hidden;border:2px solid #1a1a1a;">
                <!-- Header -->
                <tr>
                  <td style="background-color:#0a0a0a;padding:32px;text-align:center;border-bottom:3px solid #c8f135;">
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
}

module.exports = new EmailService();

