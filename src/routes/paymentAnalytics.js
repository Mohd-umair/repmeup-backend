'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const c = require('../controllers/paymentAnalyticsController');

router.use(protect);

router.get('/summary', c.getSummary);
router.get('/time-series', c.getTimeSeries);
router.get('/by-provider', c.getByProvider);
router.get('/by-channel', c.getByChannel);
router.get('/health', c.getOperationalHealth);
router.get('/by-agent', c.getByAgent);

module.exports = router;
