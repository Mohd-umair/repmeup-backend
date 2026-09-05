const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const emailAccountController = require('../controllers/emailAccountController');

// All routes require authentication except OAuth callbacks
// (callbacks come from the browser after a redirect, so the cookie is present)

// List connected email accounts
router.get('/accounts', protect, emailAccountController.listConnections);

// Gmail OAuth flow
router.get('/connect/gmail', protect, emailAccountController.connectGmail);
router.get('/callback/gmail', protect, emailAccountController.gmailCallback);

// Outlook OAuth flow
router.get('/connect/outlook', protect, emailAccountController.connectOutlook);
router.get('/callback/outlook', protect, emailAccountController.outlookCallback);

// IMAP credential-based connection
router.post('/connect/imap', protect, emailAccountController.connectImap);

// Disconnect an email account
router.delete('/:id', protect, emailAccountController.disconnectEmail);

// Manual Gmail watch renewal (admin / troubleshooting)
router.post('/:id/refresh-watch', protect, emailAccountController.refreshGmailWatch);

module.exports = router;
