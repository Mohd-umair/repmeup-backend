'use strict';

/**
 * Super-admin endpoints for the Interakt integration.
 * Mounted under /api/super-admin — the auth gate lives on that router.
 */

const interaktAdmin = require('../services/interaktAdminService');

/** GET /api/super-admin/interakt/logs */
exports.listLogs = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await interaktAdmin.listLogs(req.query) });
  } catch (error) {
    next(error);
  }
};

/** GET /api/super-admin/interakt/logs/:id — includes sanitized request/response bodies. */
exports.getLog = async (req, res, next) => {
  try {
    const row = await interaktAdmin.getLogById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'Log entry not found' });
    res.status(200).json({ success: true, data: row });
  } catch (error) {
    next(error);
  }
};

/** GET /api/super-admin/interakt/stats?days=30 */
exports.getStats = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await interaktAdmin.getStats(req.query) });
  } catch (error) {
    next(error);
  }
};

/** GET /api/super-admin/connections — every tenant's connected accounts. */
exports.listConnections = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: await interaktAdmin.listConnections(req.query) });
  } catch (error) {
    next(error);
  }
};
