'use strict';

const logger = require('../config/logger');
const paymentAnalyticsService = require('../services/payments/paymentAnalyticsService');

function _orgId(req) {
  return String(req.user?.organization?._id || req.user?.organization || '');
}

function _parseFilters(query = {}) {
  const f = {};
  if (query.from) f.from = query.from;
  if (query.to) f.to = query.to;
  if (query.provider) f.provider = query.provider;
  if (query.channel) f.channel = query.channel;
  if (query.status) f.status = query.status;
  if (query.currency) f.currency = query.currency;
  return f;
}

exports.getSummary = async (req, res) => {
  try {
    const data = await paymentAnalyticsService.getSummary(_orgId(req), _parseFilters(req.query));
    res.json({ success: true, data });
  } catch (err) {
    logger.error('[PaymentAnalytics] getSummary error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load payment summary' });
  }
};

exports.getTimeSeries = async (req, res) => {
  try {
    const data = await paymentAnalyticsService.getTimeSeries(_orgId(req), _parseFilters(req.query));
    res.json({ success: true, data });
  } catch (err) {
    logger.error('[PaymentAnalytics] getTimeSeries error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load payment time series' });
  }
};

exports.getByProvider = async (req, res) => {
  try {
    const data = await paymentAnalyticsService.getByProvider(_orgId(req), _parseFilters(req.query));
    res.json({ success: true, data });
  } catch (err) {
    logger.error('[PaymentAnalytics] getByProvider error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load provider breakdown' });
  }
};

exports.getByChannel = async (req, res) => {
  try {
    const data = await paymentAnalyticsService.getByChannel(_orgId(req), _parseFilters(req.query));
    res.json({ success: true, data });
  } catch (err) {
    logger.error('[PaymentAnalytics] getByChannel error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load channel breakdown' });
  }
};

exports.getOperationalHealth = async (req, res) => {
  try {
    const data = await paymentAnalyticsService.getOperationalHealth(_orgId(req));
    res.json({ success: true, data });
  } catch (err) {
    logger.error('[PaymentAnalytics] getOperationalHealth error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load operational health' });
  }
};

exports.getByAgent = async (req, res) => {
  try {
    const data = await paymentAnalyticsService.getByAgent(_orgId(req), _parseFilters(req.query));
    res.json({ success: true, data });
  } catch (err) {
    logger.error('[PaymentAnalytics] getByAgent error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to load agent breakdown' });
  }
};
