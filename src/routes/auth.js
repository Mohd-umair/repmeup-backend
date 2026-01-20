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

    // Handle OAuth errors
    if (error) {
      console.error('Facebook OAuth error:', error, error_description);
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=facebook&status=error&message=${encodeURIComponent(error_description || error)}`
      );
    }

    // Verify state
    const stateData = metaAuth.verifyState(state);
    const { userId, organizationId } = stateData;

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
    
    // Filter pages that have Instagram accounts
    const pagesWithInstagram = pages.filter(page => page.instagram_business_account);
    
    if (pagesWithInstagram.length === 0) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/app/settings?connection=instagram&status=error&message=No Instagram Business accounts found`
      );
    }

    // Save Instagram connections
    let savedCount = 0;
    for (const page of pagesWithInstagram) {
      try {
        await metaAuth.saveInstagramConnection(
          userId,
          organizationId,
          page,
          page.access_token
        );
        savedCount++;
      } catch (error) {
        console.error(`Failed to save Instagram account:`, error.message);
      }
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

