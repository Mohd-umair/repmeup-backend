/**
 * Email Account Controller
 *
 * Handles connecting / disconnecting email accounts across three providers:
 *   - Gmail     (Google OAuth + Gmail API watch)
 *   - Outlook   (Microsoft OAuth + Graph subscription)
 *   - IMAP      (IMAP credentials + SMTP config, stored encrypted)
 *
 * Routes:
 *   GET  /api/email/accounts              → listConnections
 *   GET  /api/email/connect/gmail         → connectGmail (redirects to Google OAuth)
 *   GET  /api/email/callback/gmail        → gmailCallback (OAuth code exchange)
 *   GET  /api/email/connect/outlook       → connectOutlook
 *   GET  /api/email/callback/outlook      → outlookCallback
 *   POST /api/email/connect/imap          → connectImap
 *   DELETE /api/email/:id                 → disconnectEmail
 *   POST /api/email/:id/refresh-watch     → refreshGmailWatch (manual renewal)
 */

const crypto = require('crypto');
const PlatformConnection = require('../models/PlatformConnection');
const logger = require('../config/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Encrypt a secret (access token / password) with AES-256-GCM.
 * Returns a colon-delimited string: "iv:authTag:ciphertext" (all base64).
 */
function _encrypt(plain) {
  const key = _encryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function _encryptionKey() {
  const raw = process.env.EMAIL_ENCRYPTION_KEY || process.env.JWT_SECRET || 'default-dev-key-32-chars-padding!!';
  return crypto.createHash('sha256').update(raw).digest(); // always 32 bytes
}

/**
 * Build a CSRF state token for OAuth flows: "<orgId>.<random>".
 */
function _buildOAuthState(organizationId) {
  return `${organizationId}.${crypto.randomBytes(16).toString('hex')}`;
}

function _orgIdFromState(state) {
  return (state || '').split('.')[0];
}

// ── List Connections ──────────────────────────────────────────────────────────

/**
 * GET /api/email/accounts
 * Returns all active email connections for the requesting organization.
 */
exports.listConnections = async (req, res, next) => {
  try {
    const connections = await PlatformConnection.find({
      organization: req.user.organization,
      platform: 'email',
      isActive: true
    })
      .select('platformDisplayName platformData.emailAddress platformData.emailProvider platformData.watchExpiry status lastSyncAt connectedAt createdAt')
      .lean();

    res.json({ success: true, data: connections });
  } catch (err) {
    next(err);
  }
};

// ── Gmail Connect ─────────────────────────────────────────────────────────────

/**
 * GET /api/email/connect/gmail
 * Initiates the Google OAuth consent flow with Gmail scopes.
 * Redirects the browser to Google's auth page.
 */
exports.connectGmail = async (req, res, next) => {
  try {
    const gmailService = require('../integrations/google/gmailService');
    const state = _buildOAuthState(req.user.organization);

    // Persist CSRF token in a short-lived cookie (5 min)
    res.cookie('email_oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 5 * 60 * 1000,
      sameSite: 'lax'
    });

    const url = gmailService.getGmailAuthUrl(state);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/email/callback/gmail
 * Handles the Google OAuth callback after user consent.
 * Exchanges the code, creates PlatformConnection, sets up Gmail watch.
 */
exports.gmailCallback = async (req, res, next) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      logger.warn('[emailAccountController] Gmail OAuth denied by user', { error });
      return res.redirect(`${process.env.FRONTEND_URL}/app/settings?email_connect=denied`);
    }

    if (!code || !state) {
      return res.status(400).json({ success: false, error: 'Missing OAuth code or state' });
    }

    // CSRF check
    const savedState = req.cookies?.email_oauth_state;
    if (!savedState || savedState !== state) {
      logger.warn('[emailAccountController] Gmail OAuth state mismatch — possible CSRF');
      return res.status(400).json({ success: false, error: 'Invalid OAuth state' });
    }
    res.clearCookie('email_oauth_state');

    const organizationId = _orgIdFromState(state);
    if (String(req.user.organization) !== organizationId) {
      return res.status(403).json({ success: false, error: 'Organization mismatch' });
    }

    const gmailService = require('../integrations/google/gmailService');
    const { tokens, email, name } = await gmailService.exchangeCodeForTokens(code);

    // Upsert PlatformConnection
    const connectionData = {
      organization: organizationId,
      platform: 'email',
      platformUserId: email,
      platformUsername: email,
      platformDisplayName: name || email,
      platformEmail: email,
      accessToken: tokens.access_token || '',
      refreshToken: tokens.refresh_token || '',
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      scope: (tokens.scope || '').split(' ').filter(Boolean),
      platformData: {
        emailProvider: 'gmail',
        emailAddress: email
      },
      status: 'connected',
      isActive: true,
      connectedAt: new Date(),
      createdBy: req.user._id
    };

    const existing = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'email',
      platformUserId: email
    });

    let connection;
    if (existing) {
      Object.assign(existing, connectionData);
      connection = await existing.save();
      logger.info('[emailAccountController] Gmail connection updated', { email, orgId: organizationId });
    } else {
      connection = await PlatformConnection.create(connectionData);
      logger.info('[emailAccountController] Gmail connection created', { email, orgId: organizationId });
    }

    // Set up Gmail Pub/Sub watch
    try {
      await gmailService.watchInbox(connection.toObject ? connection.toObject() : connection);
    } catch (watchErr) {
      logger.error('[emailAccountController] Gmail watch setup failed', {
        email,
        error: watchErr.message
      });
      // Don't fail the whole connection — user can manually refresh watch
    }

    return res.redirect(`${process.env.FRONTEND_URL}/app/settings?email_connect=success&provider=gmail`);
  } catch (err) {
    logger.error('[emailAccountController] gmailCallback error', { error: err.message });
    return res.redirect(`${process.env.FRONTEND_URL}/app/settings?email_connect=error`);
  }
};

// ── Outlook Connect ───────────────────────────────────────────────────────────

/**
 * GET /api/email/connect/outlook
 * Initiates the Microsoft OAuth flow for Outlook / Microsoft 365.
 */
exports.connectOutlook = async (req, res, next) => {
  try {
    const outlookService = require('../integrations/microsoft/outlookService');
    const state = _buildOAuthState(req.user.organization);

    res.cookie('email_oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 5 * 60 * 1000,
      sameSite: 'lax'
    });

    const url = outlookService.getAuthUrl(state);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/email/callback/outlook
 * Handles the Microsoft OAuth callback.
 */
exports.outlookCallback = async (req, res, next) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`${process.env.FRONTEND_URL}/app/settings?email_connect=denied`);
    }

    const savedState = req.cookies?.email_oauth_state;
    if (!savedState || savedState !== state) {
      return res.status(400).json({ success: false, error: 'Invalid OAuth state' });
    }
    res.clearCookie('email_oauth_state');

    const organizationId = _orgIdFromState(state);
    if (String(req.user.organization) !== organizationId) {
      return res.status(403).json({ success: false, error: 'Organization mismatch' });
    }

    const outlookService = require('../integrations/microsoft/outlookService');
    const { tokens, email, name } = await outlookService.exchangeCodeForTokens(code);

    const connectionData = {
      organization: organizationId,
      platform: 'email',
      platformUserId: email,
      platformUsername: email,
      platformDisplayName: name || email,
      platformEmail: email,
      accessToken: tokens.access_token || '',
      refreshToken: tokens.refresh_token || '',
      tokenExpiry: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
      platformData: {
        emailProvider: 'outlook',
        emailAddress: email
      },
      status: 'connected',
      isActive: true,
      connectedAt: new Date(),
      createdBy: req.user._id
    };

    const existing = await PlatformConnection.findOne({
      organization: organizationId,
      platform: 'email',
      platformUserId: email
    });

    let connection;
    if (existing) {
      Object.assign(existing, connectionData);
      connection = await existing.save();
    } else {
      connection = await PlatformConnection.create(connectionData);
    }

    // Create Graph subscription for push notifications
    try {
      await outlookService.createSubscription(connection.toObject ? connection.toObject() : connection);
    } catch (subErr) {
      logger.error('[emailAccountController] Outlook subscription setup failed', { error: subErr.message });
    }

    return res.redirect(`${process.env.FRONTEND_URL}/app/settings?email_connect=success&provider=outlook`);
  } catch (err) {
    logger.error('[emailAccountController] outlookCallback error', { error: err.message });
    return res.redirect(`${process.env.FRONTEND_URL}/app/settings?email_connect=error`);
  }
};

// ── IMAP Connect ──────────────────────────────────────────────────────────────

/**
 * POST /api/email/connect/imap
 * Body: { emailAddress, imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure, password }
 * Credentials are encrypted before storage.
 */
exports.connectImap = async (req, res, next) => {
  try {
    const {
      emailAddress,
      imapHost,
      imapPort,
      imapSecure = true,
      smtpHost,
      smtpPort,
      smtpSecure = true,
      password
    } = req.body;

    if (!emailAddress || !imapHost || !imapPort || !smtpHost || !smtpPort || !password) {
      return res.status(400).json({
        success: false,
        error: 'emailAddress, imapHost, imapPort, smtpHost, smtpPort and password are required'
      });
    }

    // Validate the credentials by attempting a test connection
    const imapService = require('../integrations/imap/imapService');
    const testResult = await imapService.testConnection({
      imapHost,
      imapPort: Number(imapPort),
      imapSecure,
      emailAddress,
      password
    });

    if (!testResult.success) {
      return res.status(400).json({
        success: false,
        error: `IMAP connection failed: ${testResult.error}. Please check your credentials and server settings.`
      });
    }

    // Encrypt password before storing
    const encryptedPassword = _encrypt(password);

    const connectionData = {
      organization: req.user.organization,
      platform: 'email',
      platformUserId: emailAddress,
      platformUsername: emailAddress,
      platformDisplayName: emailAddress,
      platformEmail: emailAddress,
      accessToken: encryptedPassword,  // encrypted password stored in accessToken field
      platformData: {
        emailProvider: 'imap',
        emailAddress,
        imapHost,
        imapPort: Number(imapPort),
        imapSecure: Boolean(imapSecure),
        smtpHost,
        smtpPort: Number(smtpPort),
        smtpSecure: Boolean(smtpSecure),
        lastPolledUid: 0
      },
      status: 'connected',
      isActive: true,
      connectedAt: new Date(),
      createdBy: req.user._id
    };

    const existing = await PlatformConnection.findOne({
      organization: req.user.organization,
      platform: 'email',
      platformUserId: emailAddress
    });

    if (existing) {
      Object.assign(existing, connectionData);
      await existing.save();
    } else {
      await PlatformConnection.create(connectionData);
    }

    logger.info('[emailAccountController] IMAP connection created', {
      emailAddress,
      orgId: req.user.organization
    });

    res.json({
      success: true,
      message: 'Email account connected successfully. Emails will appear in your inbox shortly.'
    });
  } catch (err) {
    next(err);
  }
};

// ── Disconnect ────────────────────────────────────────────────────────────────

/**
 * DELETE /api/email/:id
 * Disconnects an email account, revokes any active watch/subscription.
 */
exports.disconnectEmail = async (req, res, next) => {
  try {
    const connection = await PlatformConnection.findOne({
      _id: req.params.id,
      organization: req.user.organization,
      platform: 'email'
    });

    if (!connection) {
      return res.status(404).json({ success: false, error: 'Email connection not found' });
    }

    const provider = connection.platformData?.emailProvider;

    // Revoke provider-specific subscriptions
    try {
      if (provider === 'gmail') {
        const gmailService = require('../integrations/google/gmailService');
        // Stop the watch — Gmail will stop sending Pub/Sub notifications
        const { google } = require('googleapis');
        const auth = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          process.env.GMAIL_REDIRECT_URI
        );
        auth.setCredentials({ access_token: connection.accessToken });
        const gmail = google.gmail({ version: 'v1', auth });
        await gmail.users.stop({ userId: 'me' }).catch(() => {});
      } else if (provider === 'outlook') {
        const outlookService = require('../integrations/microsoft/outlookService');
        if (connection.platformData?.msSubscriptionId) {
          await outlookService.deleteSubscription(connection).catch(() => {});
        }
      }
    } catch (revokeErr) {
      logger.warn('[emailAccountController] error revoking watch/subscription during disconnect', {
        provider,
        error: revokeErr.message
      });
    }

    connection.isActive = false;
    connection.status = 'disconnected';
    connection.disconnectedAt = new Date();
    await connection.save();

    logger.info('[emailAccountController] email disconnected', {
      connectionId: connection._id,
      provider,
      email: connection.platformData?.emailAddress
    });

    res.json({ success: true, message: 'Email account disconnected successfully' });
  } catch (err) {
    next(err);
  }
};

// ── Manual Watch Refresh ──────────────────────────────────────────────────────

/**
 * POST /api/email/:id/refresh-watch
 * Manually renews the Gmail watch for a connection (admin/troubleshooting use).
 */
exports.refreshGmailWatch = async (req, res, next) => {
  try {
    const connection = await PlatformConnection.findOne({
      _id: req.params.id,
      organization: req.user.organization,
      platform: 'email'
    }).lean();

    if (!connection) {
      return res.status(404).json({ success: false, error: 'Email connection not found' });
    }

    if (connection.platformData?.emailProvider !== 'gmail') {
      return res.status(400).json({ success: false, error: 'Watch refresh is only available for Gmail connections' });
    }

    const gmailService = require('../integrations/google/gmailService');
    const { historyId, expiry } = await gmailService.watchInbox(connection);

    res.json({
      success: true,
      message: 'Gmail watch renewed successfully',
      data: { historyId, expiry }
    });
  } catch (err) {
    next(err);
  }
};
