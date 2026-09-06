const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const inspirationController = require('../controllers/inspirationController');

router.get('/', protect, inspirationController.list);
// Mutates the org's Brand Reference Image library — same authorization tier
// as every other Brand Hub reference-image write (brandConfig.js routes).
router.post(
  '/add-to-references',
  protect,
  authorize('super_admin', 'admin', 'manager'),
  inspirationController.addToReferences
);

module.exports = router;
