const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    this.transporter = null;
    this.initializeTransporter();
  }

  initializeTransporter() {
    // For development, use a test account or console logging
    if (process.env.NODE_ENV === 'development') {
      // Create a test transporter
      this.transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: 'ethereal.user@ethereal.email',
          pass: 'pass'
        }
      });
    } else {
      // Production: Use SendGrid, AWS SES, or other service
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.sendgrid.net',
        port: process.env.SMTP_PORT || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER || 'apikey',
          pass: process.env.SENDGRID_API_KEY || process.env.SMTP_PASS
        }
      });
    }
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
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
    const subject = 'Password Reset Request';
    const html = `
      <h2>Password Reset Request</h2>
      <p>Hi ${user.firstName},</p>
      <p>You requested a password reset. Click the link below to reset your password:</p>
      <p><a href="${resetUrl}">Reset Password</a></p>
      <p>This link will expire in 1 hour.</p>
      <p>If you didn't request this, please ignore this email.</p>
      <p>Best regards,<br>ORM System</p>
    `;

    return this.sendEmail({
      to: user.email,
      subject,
      html
    });
  }
}

module.exports = new EmailService();

