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

// Facebook OAuth
router.get('/facebook', protect, async (req, res, next) => {
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
    const { code, state, error, error_description } = req.query;

    console.log('📥 [Facebook Callback] Received callback:', {
      hasCode: !!code,
      hasState: !!state,
      hasError: !!error,
      error: error,
      errorDescription: error_description
    });

    // Handle OAuth errors
    if (error) {
      console.error('❌ [Facebook Callback] OAuth error:', error, error_description);
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=facebook&status=error&message=${encodeURIComponent(error_description || error)}`
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

    // Exchange code for token
    const shortToken = await metaAuth.exchangeCodeForToken(
      code,
      process.env.META_CALLBACK_URL
    );
    
    // Get long-lived token
    const tokenData = await metaAuth.getLongLivedToken(shortToken);
    
    // Get user pages
    const pages = await metaAuth.getUserPages(tokenData.accessToken);
    
    if (pages.length === 0) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=facebook&status=error&message=No pages found`
      );
    }

    // Save connections for all pages
    let savedCount = 0;
    for (const page of pages) {
      try {
        await metaAuth.saveFacebookConnection(
          userId,
          organizationId,
          page,
          page.access_token
        );
        savedCount++;
      } catch (error) {
        console.error(`Failed to save page ${page.name}:`, error.message);
      }
    }

    res.redirect(
      `${process.env.FRONTEND_URL}/app/settings?connection=facebook&status=success&pages=${savedCount}`
    );
  } catch (error) {
    console.error('Facebook callback error:', error);
    res.redirect(
      `${process.env.FRONTEND_URL}/app/settings?connection=facebook&status=error&message=${encodeURIComponent(error.message)}`
    );
  }
});

// Instagram OAuth
router.get('/instagram', protect, async (req, res, next) => {
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

    // Save Instagram connections
    let savedCount = 0;
    let saveErrors = [];
    
    for (const page of pagesWithInstagram) {
      try {
        console.log(`💾 [Instagram] Attempting to save Instagram account: ${page.instagram_business_account.username} (ID: ${page.instagram_business_account.id})`);
        await metaAuth.saveInstagramConnection(
          userId,
          organizationId,
          page,
          page.access_token
        );
        savedCount++;
        console.log(`✅ [Instagram] Saved connection for: ${page.instagram_business_account.username}`);
      } catch (error) {
        console.error(`❌ [Instagram] Failed to save Instagram account:`, error.message);
        console.error(`❌ [Instagram] Full error:`, error);
        console.error(`❌ [Instagram] Error stack:`, error.stack);
        saveErrors.push(error.message || error.toString());
      }
    }

    // If no accounts were saved, treat as error with helpful message
    if (savedCount === 0) {
      const errorMessage = pagesWithInstagram.length > 0
        ? `Failed to save Instagram accounts. ${saveErrors.length > 0 ? saveErrors.join('; ') : 'Please try again.'}`
        : `No Instagram Business accounts found. Your Facebook pages are not connected to Instagram Business accounts. Please link your Instagram Business account to a Facebook Page.`;
      
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=instagram&status=error&message=${encodeURIComponent(errorMessage)}&pages=${pages.length}&instagramPages=${pagesWithInstagram.length}`
      );
    }

    res.redirect(
      `${process.env.FRONTEND_URL}/app/settings?connection=instagram&status=success&accounts=${savedCount}`
    );
  } catch (error) {
    console.error('Instagram callback error:', error);
    res.redirect(
      `${process.env.FRONTEND_URL}/app/settings?connection=instagram&status=error&message=${encodeURIComponent(error.message)}`
    );
  }
});

module.exports = router;

