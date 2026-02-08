const express = require('express');
const router = express.Router();
const menuController = require('../controllers/menuController');
const { protect } = require('../middlewares/auth');

// All menu routes require authentication
router.use(protect);

// Get user's accessible menus
router.get('/', menuController.getMenus);

// Admin routes
router.get('/all', menuController.getAllMenus);
router.post('/', menuController.createMenu);
router.post('/seed', menuController.seedMenus);
router.put('/:id', menuController.updateMenu);
router.delete('/:id', menuController.deleteMenu);

module.exports = router;
