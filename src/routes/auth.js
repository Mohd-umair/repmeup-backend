const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect, authorize } = require('../middlewares/auth');
const { validateRegistration, validateLogin } = require('../middlewares/validation');

// Public routes
router.post('/register', validateRegistration, authController.register);
router.post('/login', validateLogin, authController.login);

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
router.get('/facebook', protect, checkConnectionLimit, async (req, res, next) => {
  try {
    const authURL = metaAuth.getFacebookAuthURL(
      req.user.id,
      req.user.organization._id || req.user.organization
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
      console.error('❌ [Facebook Callback] OAuth error:', {
        error,
        error_code,
        error_description,
        error_message
      });
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=facebook&status=error&message=${encodeURIComponent(errorMsg)}`
      );
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
    
    // Get user pages to verify access
    const pages = await metaAuth.getUserPages(tokenData.accessToken);
    
    if (pages.length === 0) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=facebook&status=error&message=No pages found`
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
router.get('/instagram', protect, checkConnectionLimit, async (req, res, next) => {
  try {
    const authURL = metaAuth.getInstagramAuthURL(
      req.user.id,
      req.user.organization._id || req.user.organization
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

// Google OAuth for Login/Signup (not platform connection)
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

    console.log('📥 [Google Auth Callback] Received callback:', {
      hasCode: !!code,
      hasState: !!state,
      error: error
    });

    // Handle OAuth errors
    if (error) {
      console.error('❌ [Google Auth] OAuth error:', error, error_description);
      return res.redirect(
        `${process.env.FRONTEND_URL}/login?status=error&message=${encodeURIComponent(error_description || error)}`
      );
    }

    if (!code) {
      console.error('❌ [Google Auth] Missing authorization code');
      return res.redirect(
        `${process.env.FRONTEND_URL}/login?status=error&message=Missing authorization code`
      );
    }

    // Verify state
    try {
      googleAuthService.verifyState(state);
    } catch (error) {
      console.error('❌ [Google Auth] State verification failed:', error.message);
      return res.redirect(
        `${process.env.FRONTEND_URL}/login?status=error&message=Invalid state parameter`
      );
    }

    // Exchange code for tokens
    const tokens = await googleAuthService.getTokens(code);
    console.log('✅ [Google Auth] Tokens obtained');

    // Get user profile
    const profile = await googleAuthService.getUserProfile(tokens.access_token);
    console.log('✅ [Google Auth] Profile obtained:', profile.email);

    // Login or signup user
    const result = await authController.googleAuth(profile);

    // Redirect to frontend with token
    const redirectUrl = `${process.env.FRONTEND_URL}/auth/google-callback?token=${result.token}&refreshToken=${result.refreshToken}&isNewUser=${result.isNewUser}`;
    
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('❌ [Google Auth] Callback error:', error);
    res.redirect(
      `${process.env.FRONTEND_URL}/login?status=error&message=${encodeURIComponent(error.message || 'Authentication failed')}`
    );
  }
});

module.exports = router;

