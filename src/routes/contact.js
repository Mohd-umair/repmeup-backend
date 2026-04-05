/**
 * Public contact form API (marketing site).
 */
const express = require('express');
const router = express.Router();
const { validateContactInquiry } = require('../middlewares/validation');
const contactInquiryController = require('../controllers/contactInquiryController');

router.post('/submit', validateContactInquiry, contactInquiryController.submit);

module.exports = router;
