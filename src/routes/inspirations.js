const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const inspirationController = require('../controllers/inspirationController');

router.get('/', protect, inspirationController.list);
router.post('/add-to-references', protect, inspirationController.addToReferences);

module.exports = router;
