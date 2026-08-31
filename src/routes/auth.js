const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const authController = require('../controllers/authController');
const authService = require('../services/authService');
const userActivityLogService = require('../services/userActivityLogService');
const { protect, authorize } = require('../middlewares/auth');
const { generateAdminToken } = require('../middlewares/adminAuth');
const { validateRegistration, validateLogin } = require('../middlewares/validation');
const riscController = require('../controllers/riscController');

/**
 * Strict brute-force limiter for credential/OTP endpoints. The global limiter
 * (1000 req / 15 min) is far too permissive for password and OTP guessing.
 * Disabled in development unless RATE_LIMIT_ENABLED=true, and globally
 * overridable via RATE_LIMIT_DISABLED for single-IP proxy deployments.
 */
const authLimiter = rateLimit({
  windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () =>
    process.env.RATE_LIMIT_DISABLED === 'true' ||
    (process.env.NODE_ENV === 'development' && process.env.RATE_LIMIT_ENABLED !== 'true'),
  message: { success: false, error: 'Too many attempts. Please try again later.' }
});

/**
 * Tighter brute-force limiter for the super-admin login endpoint.
 * Half the attempts of the regular auth limiter (5 vs 10) to provide an extra
 * layer of protection for the most privileged credentials in the system.
 */
const adminAuthLimiter = rateLimit({
  windowMs: parseInt(process.env.ADMIN_AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.ADMIN_AUTH_RATE_LIMIT_MAX) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () =>
    process.env.RATE_LIMIT_DISABLED === 'true' ||
    (process.env.NODE_ENV === 'development' && process.env.RATE_LIMIT_ENABLED !== 'true'),
  message: { success: false, error: 'Too many admin login attempts. Please try again later.' }
});

// Public routes
router.post('/register', authLimiter, validateRegistration, authController.register);
router.post('/login', authLimiter, validateLogin, authController.login);

/**
 * POST /api/auth/admin-login
 *
 * Dedicated login endpoint for the super-admin panel.
 *
 * Differences from the regular /auth/login:
 *   - Only accepts credentials belonging to a `super_admin` role user.
 *     Any other role receives the same "Invalid credentials" response to
 *     prevent role enumeration attacks.
 *   - Issues a token signed with SUPER_ADMIN_JWT_SECRET (separate from
 *     JWT_SECRET) so admin tokens are cryptographically independent of
 *     tenant tokens.
 *   - Protected by a tighter rate limiter (5 req / 15 min).
 */
router.post('/admin-login', adminAuthLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const result = await authService.login(email, password);

    // Silently reject non-super_admin credentials — same error message to avoid
    // role enumeration (an attacker should not learn whether the account exists).
    if (result.user.role !== 'super_admin') {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const adminToken = generateAdminToken(result.user._id);

    userActivityLogService.recordAuthEvent({
      userId: result.user._id,
      organizationId: result.user.organization?._id || result.user.organization,
      action: 'admin_login',
      path: '/api/auth/admin-login',
      method: 'POST',
      statusCode: 200,
      ip: userActivityLogService.clientIp(req),
      userAgent: req.headers['user-agent']
    });

    res.status(200).json({
      success: true,
      data: { user: result.user, token: adminToken }
    });
  } catch (error) {
    // Return a generic error message regardless of the underlying cause to
    // avoid leaking account existence or lockout state to an attacker.
    res.status(error.statusCode || 401).json({ success: false, error: 'Invalid credentials' });
  }
});
// Magic-link login for demo prospects (no password)
router.post('/demo-login', authLimiter, authController.demoLogin);
router.post('/forgot-password', authLimiter, authController.forgotPassword);
router.post('/reset-password', authLimiter, authController.resetPassword);

// Passwordless login via email OTP
router.post('/send-otp', authLimiter, authController.sendLoginOtp);
router.post('/verify-otp', authLimiter, authController.verifyLoginOtp);

router.post('/verify-email', authController.verifyEmail);
router.post('/resend-verification', authController.resendVerification);

// Protected routes
router.get('/me', protect, authController.getMe);
router.put('/profile', protect, authController.updateProfile);
router.put('/change-password', protect, authController.changePassword);
router.post('/logout', protect, authController.logout);

// Admin/Manager only routes
router.post(
  '/team-member',
  protect,
  authorize('admin', 'manager'),
  authController.createTeamMember
);

// Meta (Facebook/Instagram) OAuth routes
const metaAuth = require('../integrations/meta/metaAuth');
const { checkConnectionLimit } = require('../middlewares/platformLimitMiddleware');

// LinkedIn OAuth routes
const linkedinAuth = require('../integrations/linkedin/linkedinAuth');
const { isComingSoonPlatform, COMING_SOON_PLATFORM_MESSAGE } = require('../constants/platformAvailability');

// Google OAuth for authentication (login/signup)
const googleAuthService = require('../integrations/google/googleAuthService');

// Facebook OAuth - check plan limit before starting OAuth
// Query: auth_type=reauthorize to force Meta to show the consent screen (for App Review screencast)
router.get('/facebook', protect, checkConnectionLimit, async (req, res, next) => {
  try {
    const options = {};
    if (req.query.auth_type === 'reauthorize') options.auth_type = 'reauthorize';
    const authURL = metaAuth.getFacebookAuthURL(
      String(req.user._id),
      String(req.user.organization?._id || req.user.organization),
      options
    );

    res.json({
      success: true,
      authUrl: authURL
    });
  } catch (error) {
    next(error);
  }
});

router.get('/facebook/callback', async (req, res) => {
  try {
    const { code, state, error, error_description, error_code, error_message } = req.query;

    console.log('📥 [Facebook Callback] Received callback:', {
      hasCode: !!code,
      hasState: !!state,
      hasError: !!error,
      hasErrorCode: !!error_code,
      error: error,
      errorDescription: error_description,
      errorCode: error_code,
      errorMessage: error_message
    });

    // Handle OAuth errors (Facebook can send error in multiple formats)
    if (error || error_code) {
      const errorMsg = error_message || error_description || error || 'Unknown OAuth error';
    
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=facebook&status=error&message=${encodeURIComponent(errorMsg)}`
      );
    }

    // Meta may send a  to validate the callback URL (no code/state). Respond 200 so validation succeeds.
    if (!code && !state) {
      res.status(200).send('OK');
      return;
    }

    // Check for required parameters
    if (!code) {
      console.error('❌ [Facebook Callback] Missing authorization code');
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=facebook&status=error&message=${encodeURIComponent('Missing authorization code')}`
      );
    }

    if (!state) {
      console.error('❌ [Facebook Callback] Missing state parameter');
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=facebook&status=error&message=${encodeURIComponent('Missing state parameter. Please try connecting again.')}`
      );
    }

    // Decode state if it's URL-encoded (Express should do this automatically, but just in case)
    let decodedState = state;
    try {
      // Try URL decoding if needed
      if (state.includes('%')) {
        decodedState = decodeURIComponent(state);
        console.log('🔓 [Facebook Callback] URL-decoded state parameter');
      }
    } catch (decodeError) {
      console.warn('⚠️ [Facebook Callback] Could not URL-decode state, using as-is:', decodeError.message);
    }

    // Verify state
    let stateData;
    try {
      stateData = metaAuth.verifyState(decodedState);
    } catch (stateError) {
      console.error('❌ [Facebook Callback] State verification failed:', stateError.message);
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=facebook&status=error&message=${encodeURIComponent(stateError.message || 'Invalid state parameter. Please try connecting again.')}`
      );
    }

    const { userId, organizationId } = stateData;
    console.log('✅ [Facebook Callback] State verified, proceeding with token exchange...');

    // Get redirect URI using the same logic as OAuth URL generation
    // This MUST match exactly what was used in the OAuth request
    const redirectUri = metaAuth.getFacebookRedirectURI();
    console.log('🔗 [Facebook Callback] Using redirect URI for token exchange:', redirectUri);

    // Exchange code for token
    const shortToken = await metaAuth.exchangeCodeForToken(
      code,
      redirectUri
    );
    
    // Get long-lived token
    const tokenData = await metaAuth.getLongLivedToken(shortToken);
    
    // Get user info (optional when rate limited — we'll try minimal info from token and still fetch pages)
    let userInfo;
    try {
      userInfo = await metaAuth.getUserInfo(tokenData.accessToken);
    } catch (userInfoError) {
      if (userInfoError.isRateLimit) {
        console.warn('[Meta] Get user info rate limited; trying minimal user from token and continuing...');
        userInfo = await metaAuth.getMinimalUserFromToken(tokenData.accessToken);
        if (!userInfo) {
          console.warn('[Meta] Could not get user id from token; skipping user-level connection save');
        }
      } else {
        throw userInfoError;
      }
    }
    
    if (userInfo && userInfo.id) {
      try {
        await metaAuth.saveFacebookUserConnection(userId, organizationId, tokenData.accessToken, userInfo);
        console.log(`✅ [Meta] Saved Facebook user-level connection for page management`);
      } catch (error) {
        console.error(`⚠️  [Meta] Failed to save user-level connection:`, error.message);
      }
    }
    
    // Get user pages to verify access (required for connect flow to succeed)
    const pages = await metaAuth.getUserPages(tokenData.accessToken);
    
    if (pages.length === 0) {
      const msg = encodeURIComponent(
        'No pages found. Ensure you have a Facebook Page with Admin/Editor role, grant all permissions (including Business Account access if your Page is linked to a Business), or create a Page at facebook.com/pages'
      );
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=facebook&status=error&message=${msg}`
      );
    }

    console.log(`✅ [Facebook] User has access to ${pages.length} pages. They can connect individual pages via Page Manager.`);

    // Redirect to success - users will connect specific pages via Page Manager
    res.redirect(
      `${process.env.FRONTEND_URL}/app/settings?connection=facebook&status=success&pages=${pages.length}&message=${encodeURIComponent('Facebook connected! Go to Page Manager to connect specific pages.')}`
    );
  } catch (error) {
    console.error('Facebook callback error:', error);
    res.redirect(
      `${process.env.FRONTEND_URL}/app/settings?connection=facebook&status=error&message=${encodeURIComponent(error.message)}`
    );
  }
});

// Instagram OAuth - check plan limit before starting OAuth
// Query: auth_type=reauthorize to force Meta to show the consent screen (for App Review screencast)
router.get('/instagram', protect, checkConnectionLimit, async (req, res, next) => {
  try {
    const options = {};
    if (req.query.auth_type === 'reauthorize') options.auth_type = 'reauthorize';
    const authURL = metaAuth.getInstagramAuthURL(
      String(req.user._id),
      String(req.user.organization?._id || req.user.organization),
      options
    );

    res.json({
      success: true,
      authUrl: authURL
    });
  } catch (error) {
    next(error);
  }
});

router.get('/instagram/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    // Meta webhook verification (hub.mode=subscribe or hub_mode=subscribe)
    const hubMode = req.query['hub.mode'] || req.query.hub_mode;
    const hubChallenge = req.query['hub.challenge'] || req.query.hub_challenge;
    const hubVerifyToken = req.query['hub.verify_token'] || req.query.hub_verify_token;

    if (hubMode === 'subscribe' && hubChallenge != null) {
      const expectedToken = process.env.META_VERIFY_TOKEN || 'REP_ME_UP';
      if (hubVerifyToken === expectedToken) {
        console.log('✅ [Meta] Webhook verification successful (Instagram callback)');
        res.status(200).send(String(hubChallenge));
        return;
      }
      console.warn('⚠️ [Meta] Webhook verify_token mismatch');
      res.status(403).send('Forbidden');
      return;
    }

    // Meta may send a GET to validate the callback URL (no code/state). Respond 200 so validation succeeds.
    if (!code && !state && !error) {
      res.status(200).send('OK');
      return;
    }

    // Handle OAuth errors
    if (error) {
      console.error('Instagram OAuth error:', error, error_description);
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=instagram&status=error&message=${encodeURIComponent(error_description || error)}`
      );
    }

    // Verify state
    const stateData = metaAuth.verifyState(state);
    const { userId, organizationId } = stateData;

    // Exchange code for token
    const shortToken = await metaAuth.exchangeCodeForToken(
      code,
      process.env.INSTAGRAM_CALLBACK_URL || process.env.META_CALLBACK_URL
    );
    
    // Get long-lived token
    const tokenData = await metaAuth.getLongLivedToken(shortToken);
    
    // Get user info first
    const userInfo = await metaAuth.getUserInfo(tokenData.accessToken);
    
    // Save user-level Facebook connection (needed for /me/accounts API calls)
    try {
      await metaAuth.saveFacebookUserConnection(userId, organizationId, tokenData.accessToken, userInfo);
      console.log(`✅ [Meta] Saved Facebook user-level connection for page management`);
    } catch (error) {
      console.error(`⚠️  [Meta] Failed to save user-level connection:`, error.message);
      // Continue anyway - page connections can still work
    }
    
    // Get user pages (Instagram accounts are linked to pages)
    const pages = await metaAuth.getUserPages(tokenData.accessToken);
    
    console.log(`📊 [Instagram] Found ${pages.length} Facebook pages`);
    if (pages.length > 0) {
      pages.forEach((page, index) => {
        console.log(`   Page ${index + 1}: ${page.name} (ID: ${page.id}) - Instagram: ${page.instagram_business_account ? '✅ Connected' : '❌ Not connected'}`);
      });
    }
    
    // Filter pages that have Instagram accounts
    const pagesWithInstagram = pages.filter(page => page.instagram_business_account);
    
    if (pagesWithInstagram.length === 0) {
      const pageNames = pages.length > 0 
        ? pages.map(p => p.name).join(', ')
        : 'No pages found';
      
      const errorMessage = pages.length === 0
        ? 'No Facebook pages found. Please create a Facebook Page first, then connect it to your Instagram Business account.'
        : `No Instagram Business accounts found. Your Facebook pages (${pageNames}) are not connected to Instagram Business accounts. Please link your Instagram Business account to a Facebook Page.`;
      
      console.error(`❌ [Instagram] ${errorMessage}`);
      
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=instagram&status=error&message=${encodeURIComponent(errorMessage)}&pages=${pages.length}`
      );
    }

    console.log(`✅ [Instagram] User has access to ${pagesWithInstagram.length} Instagram accounts. They can connect individual accounts via Page Manager.`);

    res.redirect(
      `${process.env.FRONTEND_URL}/app/settings?connection=instagram&status=success&accounts=${pagesWithInstagram.length}&message=${encodeURIComponent('Instagram connected! Use Page Manager to connect specific accounts.')}`
    );
  } catch (error) {
    console.error('Instagram callback error:', error);
    res.redirect(
      `${process.env.FRONTEND_URL}/app/settings?connection=instagram&status=error&message=${encodeURIComponent(error.message)}`
    );
  }
});

// ---------------------------------------------------------------------------
// Instagram Direct Connect — auto-saves all IG accounts without Page Manager
// ---------------------------------------------------------------------------

// GET /api/auth/instagram-direct  — generate OAuth URL
router.get('/instagram-direct', protect, checkConnectionLimit, async (req, res, next) => {
  try {
    const appId = process.env.META_APP_ID || process.env.INSTAGRAM_APP_ID || process.env.FACEBOOK_APP_ID;
    if (!appId) {
      return res.status(500).json({ success: false, error: 'Meta App ID not configured.' });
    }

    const state = metaAuth.generateState(
      String(req.user._id),
      String(req.user.organization?._id || req.user.organization),
      'instagram-direct'
    );

    const redirectUri = metaAuth.getInstagramDirectRedirectURI();

    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      state,
      scope: [
        'public_profile',
        'instagram_basic',
        'instagram_manage_comments',
        'instagram_manage_messages',
        'instagram_manage_insights',
        'instagram_content_publish',
        'pages_show_list',
        'pages_read_engagement',
        'pages_manage_posts',
        'pages_manage_engagement',
        'pages_manage_metadata',
        'pages_read_user_content',
        'business_management'
      ].join(','),
      response_type: 'code',
      auth_type: 'rerequest',
      display: 'page'
    });

    const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?${params.toString()}`;
    res.json({ success: true, authUrl });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/instagram-direct/callback  — exchange code, auto-save IG accounts, redirect
router.get('/instagram-direct/callback', async (req, res) => {
  const frontendBase = process.env.FRONTEND_URL;

  try {
    const { code, state, error: oauthError, error_description } = req.query;

    // Meta GET probe to validate the callback URL (no code/state)
    if (!code && !state && !oauthError) {
      return res.status(200).send('OK');
    }

    if (oauthError) {
      console.error('[InstagramDirect] OAuth error:', oauthError, error_description);
      return res.redirect(
        `${frontendBase}/app/settings?connection=instagram-direct&status=error&message=${encodeURIComponent(error_description || oauthError)}`
      );
    }

    if (!code || !state) {
      return res.redirect(
        `${frontendBase}/app/settings?connection=instagram-direct&status=error&message=${encodeURIComponent('Missing authorization code or state.')}`
      );
    }

    // Decode URL-encoded state if needed
    let decodedState = state;
    try {
      if (state.includes('%')) decodedState = decodeURIComponent(state);
    } catch (_) {}

    const stateData = metaAuth.verifyState(decodedState);
    const { userId, organizationId } = stateData;

    const redirectUri = metaAuth.getInstagramDirectRedirectURI();
    const shortToken = await metaAuth.exchangeCodeForToken(code, redirectUri);
    const tokenData = await metaAuth.getLongLivedToken(shortToken);

    // Get user info (best-effort — continue even if rate limited)
    let userInfo;
    try {
      userInfo = await metaAuth.getUserInfo(tokenData.accessToken);
    } catch (err) {
      if (err.isRateLimit) {
        userInfo = await metaAuth.getMinimalUserFromToken(tokenData.accessToken);
      } else {
        throw err;
      }
    }

    // Save user-level Facebook connection so Page Manager stays functional
    if (userInfo && userInfo.id) {
      try {
        await metaAuth.saveFacebookUserConnection(userId, organizationId, tokenData.accessToken, userInfo);
      } catch (err) {
        console.warn('[InstagramDirect] Could not save user-level FB connection:', err.message);
      }
    }

    // Auto-discover and save all Instagram accounts linked to the user's Facebook pages
    const { savedCount, igAccounts, errors } = await metaAuth.autoSaveInstagramConnections(
      userId,
      organizationId,
      tokenData.accessToken,
      userInfo || {}
    );

    if (savedCount === 0) {
      const noAccountMsg = errors.length
        ? errors.join(' | ')
        : 'No Instagram Professional accounts were found. Make sure your Instagram account is a Business or Creator account and is linked to a Facebook Page.';

      return res.redirect(
        `${frontendBase}/app/settings?connection=instagram-direct&status=error&message=${encodeURIComponent(noAccountMsg)}`
      );
    }

    const successMsg = igAccounts.map(a => `@${a.username}`).join(', ');
    res.redirect(
      `${frontendBase}/app/settings?connection=instagram-direct&status=success&accounts=${savedCount}&names=${encodeURIComponent(successMsg)}`
    );
  } catch (error) {
    console.error('[InstagramDirect] Callback error:', error);
    res.redirect(
      `${frontendBase}/app/settings?connection=instagram-direct&status=error&message=${encodeURIComponent(error.message || 'Instagram connection failed.')}`
    );
  }
});

// ---------------------------------------------------------------------------
// Instagram Login — Instagram API with Instagram Login (no Facebook required)
// https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
// ---------------------------------------------------------------------------

const instagramLoginAuth = require('../integrations/meta/instagramLoginAuth');

// GET /api/auth/instagram-login  — generate OAuth URL
router.get('/instagram-login', protect, checkConnectionLimit, async (req, res, next) => {
  try {
    const authUrl = instagramLoginAuth.getAuthURL(
      String(req.user._id),
      String(req.user.organization?._id || req.user.organization)
    );
    res.json({ success: true, authUrl });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/instagram-login/callback  — exchange code, save connection, redirect
router.get('/instagram-login/callback', async (req, res) => {
  const frontendBase = process.env.FRONTEND_URL;

  try {
    const { code, state, error: oauthError, error_description } = req.query;

    // Meta GET probe to validate the callback URL
    if (!code && !state && !oauthError) {
      return res.status(200).send('OK');
    }

    if (oauthError) {
      console.error('[InstagramLogin] OAuth error:', oauthError, error_description);
      return res.redirect(
        `${frontendBase}/app/settings?connection=instagram-login&status=error&message=${encodeURIComponent(error_description || oauthError)}`
      );
    }

    if (!code || !state) {
      return res.redirect(
        `${frontendBase}/app/settings?connection=instagram-login&status=error&message=${encodeURIComponent('Missing authorization code or state.')}`
      );
    }

    // Decode URL-encoded state if needed
    let decodedState = state;
    try {
      if (state.includes('%')) decodedState = decodeURIComponent(state);
    } catch (_) {}

    const stateData = instagramLoginAuth.verifyState(decodedState);
    const { userId, organizationId } = stateData;

    const redirectUri = instagramLoginAuth.getRedirectURI();

    // Exchange code for short-lived token
    const shortToken = await instagramLoginAuth.exchangeCode(code, redirectUri);

    // Get long-lived token (60 days)
    const { accessToken, expiresIn } = await instagramLoginAuth.getLongLivedToken(shortToken);

    // Get Instagram user info
    const userInfo = await instagramLoginAuth.getUserInfo(accessToken);

    // Save the connection (creates or updates PlatformConnection)
    const connection = await instagramLoginAuth.saveConnection(
      userId,
      organizationId,
      accessToken,
      expiresIn,
      userInfo
    );

    console.log(`[InstagramLogin] Connected @${userInfo.username} for org ${organizationId}`);

    res.redirect(
      `${frontendBase}/app/settings?connection=instagram-login&status=success&accounts=1&names=${encodeURIComponent('@' + userInfo.username)}`
    );
  } catch (error) {
    console.error('[InstagramLogin] Callback error:', error);
    const msg = error.code === 'CROSS_ORG_CONFLICT'
      ? error.message
      : (error.message || 'Instagram connection failed.');
    res.redirect(
      `${frontendBase}/app/settings?connection=instagram-login&status=error&message=${encodeURIComponent(msg)}`
    );
  }
});

// LinkedIn OAuth
router.get('/linkedin', protect, async (req, res, next) => {
  try {
    if (isComingSoonPlatform('linkedin')) {
      return res.status(403).json({
        success: false,
        error: COMING_SOON_PLATFORM_MESSAGE,
        code: 'PLATFORM_COMING_SOON'
      });
    }

    const state = linkedinAuth.generateState(
      String(req.user._id),
      String(req.user.organization?._id || req.user.organization)
    );
    
    const authURL = linkedinAuth.getAuthURL(state);
    
    res.json({ 
      success: true, 
      authUrl: authURL 
    });
  } catch (error) {
    next(error);
  }
});

router.get('/linkedin/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    console.log('📥 [LinkedIn Callback] Received callback:', {
      hasCode: !!code,
      hasState: !!state,
      error: error
    });

    // Handle OAuth errors
    if (error) {
      console.error('❌ [LinkedIn] OAuth error:', error, error_description);
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=linkedin&status=error&message=${encodeURIComponent(error_description || error)}`
      );
    }

    if (!code || !state) {
      console.error('❌ [LinkedIn] Missing code or state');
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=linkedin&status=error&message=Missing authorization code or state`
      );
    }

    // Verify state
    let stateData;
    try {
      stateData = linkedinAuth.verifyState(state);
      console.log('✅ [LinkedIn] State verified:', stateData);
    } catch (error) {
      console.error('❌ [LinkedIn] State verification failed:', error.message);
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=linkedin&status=error&message=Invalid state parameter`
      );
    }

    const { userId, organizationId } = stateData;

    // Exchange code for token
    const tokenData = await linkedinAuth.exchangeCodeForToken(code);
    console.log('✅ [LinkedIn] Token obtained');

    // Get user profile
    const profile = await linkedinAuth.getUserProfile(tokenData.accessToken);
    console.log('✅ [LinkedIn] Profile obtained:', profile.name);

    // Get user's organizations
    const orgData = await linkedinAuth.getUserOrganizations(tokenData.accessToken);
    console.log('✅ [LinkedIn] Organizations obtained:', orgData.organizations.length);

    // Save connections
    const connections = await linkedinAuth.saveLinkedInConnection(
      userId,
      organizationId,
      tokenData.accessToken,
      tokenData.refreshToken,
      tokenData.expiresIn,
      profile,
      orgData
    );

    const savedCount = connections.length;
    console.log(`✅ [LinkedIn] Saved ${savedCount} connection(s)`);

    // Redirect to frontend with success
    res.redirect(
      `${process.env.FRONTEND_URL}/app/settings?connection=linkedin&status=success&accounts=${savedCount}&organizations=${orgData.organizations.length}`
    );
  } catch (error) {
    console.error('❌ [LinkedIn] Callback error:', error);
    res.redirect(
      `${process.env.FRONTEND_URL}/app/settings?connection=linkedin&status=error&message=${encodeURIComponent(error.message)}`
    );
  }
});

// ---------------------------------------------------------------------------
// Google Cross-Account Protection (RISC) endpoints
// ---------------------------------------------------------------------------

// Raw body parser for RISC SETs (Content-Type: application/secevent+jwt)
const riscRawBody = express.text({ type: ['application/secevent+jwt', 'text/plain', 'application/json'] });

// POST /api/auth/risc/receiver — public, called by Google
router.post('/risc/receiver', riscRawBody, riscController.receiveSecurityEvent);

// GET /api/auth/risc/status — admin only
router.get('/risc/status', protect, authorize('admin'), riscController.getStatus);

// ---------------------------------------------------------------------------
// Google OAuth for Login/Signup (not platform connection)
// ---------------------------------------------------------------------------
router.get('/google', async (req, res, next) => {
  try {
    const authURL = googleAuthService.getAuthURL();
    
    res.json({ 
      success: true, 
      authUrl: authURL 
    });
  } catch (error) {
    next(error);
  }
});

router.get('/google/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/login?status=error&message=${encodeURIComponent(error_description || error)}`
      );
    }

    if (!code) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/login?status=error&message=Missing authorization code`
      );
    }

    // Verify state
    try {
      googleAuthService.verifyState(state);
    } catch (error) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/login?status=error&message=Invalid state parameter`
      );
    }

    const tokens = await googleAuthService.getTokens(code);
    const profile = await googleAuthService.getUserProfile(tokens.access_token);
    const result = await authController.googleAuth(profile);

    const u = result.user;
    const uid = u._id || u.id;
    const org = u.organization;
    const orgId =
      org && typeof org === 'object' && org._id ? org._id : org;
    userActivityLogService.recordAuthEvent({
      userId: uid,
      organizationId: orgId,
      action: 'google_oauth_login',
      path: '/api/auth/google/callback',
      method: 'GET',
      statusCode: 302,
      ip: userActivityLogService.clientIp(req),
      userAgent: req.headers['user-agent'],
      metadata: { isNewUser: Boolean(result.isNewUser) }
    });

    const redirectUrl = `${process.env.FRONTEND_URL}/auth/google-callback?token=${result.token}&refreshToken=${result.refreshToken}&isNewUser=${result.isNewUser}`;
    res.redirect(redirectUrl);
  } catch (error) {
    res.redirect(
      `${process.env.FRONTEND_URL}/login?status=error&message=${encodeURIComponent(error.message || 'Authentication failed')}`
    );
  }
});

module.exports = router;

