const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const ctrl = require('../controllers/commerceOrderController');

router.use(protect);

router.get('/',           ctrl.listOrders);
router.get('/stats',      ctrl.getOrderStats);
router.get('/:id',        ctrl.getOrder);
router.post('/',          ctrl.createOrder);
router.patch('/:id/status', ctrl.updateOrderStatus);
router.delete('/:id',     ctrl.cancelOrder);

module.exports = router;
