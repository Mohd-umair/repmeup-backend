/**
 * Public demo booking API (marketing site).
 */
const express = require('express');
const router = express.Router();
const { validateDemoBooking } = require('../middlewares/validation');
const demoBookingController = require('../controllers/demoBookingController');

router.post('/book', validateDemoBooking, demoBookingController.book);

module.exports = router;
