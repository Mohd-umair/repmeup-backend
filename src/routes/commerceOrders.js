const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { requireLevel } = require('../middlewares/requireFeature');
const { FEATURE_KEYS } = require('../config/featureCatalog');
const ctrl = require('../controllers/commerceOrderController');

router.use(protect);

/**
 * Order management ladder: none → basic → full. Same gate as the inbox ops orders
 * surface, which is the other door onto the same records.
 *
 * Reads and cancel stay open: an org that loses the entitlement must still be able to
 * see its order history and cancel anything outstanding. Only creating and advancing
 * orders is gated.
 */
const requireOrdersBasic = requireLevel(FEATURE_KEYS.COMMERCE_ORDERS_LEVEL, 'basic');

router.get('/',           ctrl.listOrders);
router.get('/stats',      ctrl.getOrderStats);
router.get('/:id',        ctrl.getOrder);
router.post('/',          requireOrdersBasic, ctrl.createOrder);
router.patch('/:id/status', requireOrdersBasic, ctrl.updateOrderStatus);
router.delete('/:id',     ctrl.cancelOrder);

module.exports = router;
