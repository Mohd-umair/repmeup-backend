const leadService = require('../services/crm/leadService');
const leadCaptureService = require('../services/crm/leadCaptureService');
const leadAnalyticsService = require('../services/crm/leadAnalyticsService');

exports.listLeads = async (req, res, next) => {
  try {
    const { items, pagination } = await leadService.listLeads(req.query);
    res.json({ success: true, data: { items, pagination } });
  } catch (err) {
    next(err);
  }
};

exports.createLead = async (req, res, next) => {
  try {
    const lead = await leadService.createLead(req.body, req.user);
    res.status(201).json({ success: true, data: lead });
  } catch (err) {
    next(err);
  }
};

exports.getBoard = async (req, res, next) => {
  try {
    const board = await leadService.getBoard(req.query);
    res.json({ success: true, data: board });
  } catch (err) {
    next(err);
  }
};

exports.listFollowUps = async (req, res, next) => {
  try {
    const { items, pagination } = await leadService.listFollowUps(req.query);
    res.json({ success: true, data: { items, pagination } });
  } catch (err) {
    next(err);
  }
};

exports.getMeta = async (req, res, next) => {
  try {
    const meta = await leadService.getMeta();
    res.json({ success: true, data: meta });
  } catch (err) {
    next(err);
  }
};

exports.getLead = async (req, res, next) => {
  try {
    const lead = await leadService.getLead(req.params.id);
    res.json({ success: true, data: lead });
  } catch (err) {
    next(err);
  }
};

exports.updateLead = async (req, res, next) => {
  try {
    const lead = await leadService.updateLead(req.params.id, req.body, req.user);
    res.json({ success: true, data: lead });
  } catch (err) {
    next(err);
  }
};

exports.changeStatus = async (req, res, next) => {
  try {
    const lead = await leadService.changeStatus(req.params.id, req.body.status, req.user, {
      lostReason: req.body.lostReason
    });
    res.json({ success: true, data: lead });
  } catch (err) {
    next(err);
  }
};

exports.assignLead = async (req, res, next) => {
  try {
    const lead = await leadService.assignLead(req.params.id, req.body.userId || null, req.user);
    res.json({ success: true, data: lead });
  } catch (err) {
    next(err);
  }
};

exports.deleteLead = async (req, res, next) => {
  try {
    await leadService.softDeleteLead(req.params.id);
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    next(err);
  }
};

exports.listActivities = async (req, res, next) => {
  try {
    const { items, pagination } = await leadService.listActivities(req.params.id, req.query);
    res.json({ success: true, data: { items, pagination } });
  } catch (err) {
    next(err);
  }
};

exports.addActivity = async (req, res, next) => {
  try {
    const activity = await leadService.addActivity(req.params.id, req.body, req.user);
    res.status(201).json({ success: true, data: activity });
  } catch (err) {
    next(err);
  }
};

exports.completeTask = async (req, res, next) => {
  try {
    const task = await leadService.completeTask(req.params.id, req.params.activityId, req.user);
    res.json({ success: true, data: task });
  } catch (err) {
    next(err);
  }
};

exports.getAnalyticsSummary = async (req, res, next) => {
  try {
    const summary = await leadAnalyticsService.getSummary(req.query);
    res.json({ success: true, data: summary });
  } catch (err) {
    next(err);
  }
};

exports.getAnalyticsTimeSeries = async (req, res, next) => {
  try {
    const series = await leadAnalyticsService.getTimeSeries(req.query);
    res.json({ success: true, data: series });
  } catch (err) {
    next(err);
  }
};

exports.getAnalyticsFunnel = async (req, res, next) => {
  try {
    const funnel = await leadAnalyticsService.getFunnel(req.query);
    res.json({ success: true, data: funnel });
  } catch (err) {
    next(err);
  }
};

exports.getAnalyticsTimeInStage = async (req, res, next) => {
  try {
    const stages = await leadAnalyticsService.getTimeInStage();
    res.json({ success: true, data: stages });
  } catch (err) {
    next(err);
  }
};

exports.runBackfill = async (req, res, next) => {
  try {
    const counts = await leadCaptureService.backfill();
    res.json({ success: true, data: counts });
  } catch (err) {
    next(err);
  }
};
