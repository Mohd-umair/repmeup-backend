/**
 * Super Admin CRM — platform lead management.
 * Mounted at /api/super-admin/crm; JWT + super_admin inherited from parent router.
 */
const express = require('express');
const router = express.Router();
const crmLeadController = require('../../controllers/crmLeadController');
const {
  validateLeadCreate,
  validateLeadUpdate,
  validateLeadStatus,
  validateLeadAssign,
  validateActivityCreate,
  validateLeadListQuery,
  validateFollowUpsQuery,
  validateAnalyticsQuery
} = require('../../middlewares/crmValidation');

// Static paths must come before /leads/:id
router.get('/leads/board', crmLeadController.getBoard);
router.get('/leads/followups', validateFollowUpsQuery, crmLeadController.listFollowUps);
router.get('/leads/meta', crmLeadController.getMeta);

router.get('/leads', validateLeadListQuery, crmLeadController.listLeads);
router.post('/leads', validateLeadCreate, crmLeadController.createLead);

router.get('/leads/:id', crmLeadController.getLead);
router.patch('/leads/:id', validateLeadUpdate, crmLeadController.updateLead);
router.patch('/leads/:id/status', validateLeadStatus, crmLeadController.changeStatus);
router.patch('/leads/:id/assign', validateLeadAssign, crmLeadController.assignLead);
router.delete('/leads/:id', crmLeadController.deleteLead);

router.get('/leads/:id/activities', crmLeadController.listActivities);
router.post('/leads/:id/activities', validateActivityCreate, crmLeadController.addActivity);
router.patch('/leads/:id/activities/:activityId/complete', crmLeadController.completeTask);

router.get('/analytics/summary', validateAnalyticsQuery, crmLeadController.getAnalyticsSummary);
router.get('/analytics/timeseries', validateAnalyticsQuery, crmLeadController.getAnalyticsTimeSeries);
router.get('/analytics/funnel', validateAnalyticsQuery, crmLeadController.getAnalyticsFunnel);
router.get('/analytics/time-in-stage', crmLeadController.getAnalyticsTimeInStage);

router.post('/backfill', crmLeadController.runBackfill);

module.exports = router;
