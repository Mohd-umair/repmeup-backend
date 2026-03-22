const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const userActivityLogService = require('../services/userActivityLogService');
const { protect, authorize } = require('../middlewares/auth');
const { validateRegistration, validateLogin } = require('../middlewares/validation');
const riscController = require('../controllers/riscController');

// Public routes
router.post('/register', validateRegistration, authController.register);
router.post('/login', validateLogin, authController.login);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

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
const { checkConnectionLimit } = require('../middleware/platformLimitMiddleware');

// LinkedIn OAuth routes
const linkedinAuth = require('../integrations/linkedin/linkedinAuth');

// Google OAuth for authentication (login/signup)
const googleAuthService = require('../integrations/google/googleAuthService');

// Facebook OAuth - check plan limit before starting OAuth
// Query: auth_type=reauthorize to force Meta to show the consent screen (for App Review screencast)
router.get('/facebook', protect, checkConnectionLimit, async (req, res, next) => {
  try {
    const options = {};
    if (req.query.auth_type === 'reauthorize') options.auth_type = 'reauthorize';
    const authURL = metaAuth.getFacebookAuthURL(
      req.user.id,
      req.user.organization._id || req.user.organization,
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
      req.user.id,
      req.user.organization._id || req.user.organization,
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

// LinkedIn OAuth
router.get('/linkedin', protect, async (req, res, next) => {
  try {
    const state = linkedinAuth.generateState(
      req.user.id,
      req.user.organization._id || req.user.organization
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

