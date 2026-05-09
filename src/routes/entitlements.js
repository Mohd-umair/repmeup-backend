/**
 * Entitlements API
 *
 * Authenticated org users read their resolved feature snapshot from here.
 * The frontend `EntitlementsStore` polls/subscribes to this once per session
 * and re-fetches on socket-pushed `entitlements:invalidated` events.
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const featureController = require('../controllers/featureController');

router.use(protect);
router.get('/', featureController.getMine);

module.exports = router;
