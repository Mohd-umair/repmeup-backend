const express = require('express');
const router = express.Router();
const auditLogController = require('../controllers/auditLogController');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect);
router.get('/', authorize('admin', 'manager'), auditLogController.getAuditLogs);

module.exports = router;
