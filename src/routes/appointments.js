const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const ctrl = require('../controllers/appointmentController');

// PUBLIC — Google Calendar OAuth redirect (no auth token; identity is in `state`).
router.get('/providers/google/callback', ctrl.providerGoogleCallback);

router.use(protect);

// ── Catalog: services & providers (specific paths before /:id) ───────────────
router.get('/services',        ctrl.listServices);
router.post('/services',       ctrl.createService);
router.patch('/services/:id',  ctrl.updateService);
router.delete('/services/:id', ctrl.deleteService);

router.get('/providers',        ctrl.listProviders);
router.post('/providers',       ctrl.createProvider);
router.patch('/providers/:id',  ctrl.updateProvider);
router.delete('/providers/:id', ctrl.deleteProvider);
router.get('/providers/:id/google/connect',    ctrl.connectProviderGoogle);
router.delete('/providers/:id/google',         ctrl.disconnectProviderGoogle);

// ── Availability + stats (before /:id) ───────────────────────────────────────
router.get('/availability', ctrl.getAvailability);
router.get('/stats',        ctrl.getStats);
router.get('/by-interaction/:interactionId', ctrl.getByInteraction);

// ── Appointments ─────────────────────────────────────────────────────────────
router.get('/',                  ctrl.listAppointments);
router.post('/',                 ctrl.createAppointment);
router.get('/:id',               ctrl.getAppointment);
router.patch('/:id/status',      ctrl.updateStatus);
router.patch('/:id/reschedule',  ctrl.reschedule);
router.delete('/:id',            ctrl.cancelAppointment);

module.exports = router;
