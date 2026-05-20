/**
 * Number Reports Routes
 * Base: /api/reports/number
 *
 *   GET /api/reports/number/:connectionId?days=30
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const ctrl = require('../controllers/numberReportController');

router.get('/:connectionId', protect, ctrl.getNumberReport);

module.exports = router;
