const { getNumberReport } = require('../services/numberReportService');

exports.getNumberReport = async (req, res) => {
  try {
    const orgId = req.user.organization._id;
    const { connectionId } = req.params;
    const { days } = req.query;

    const report = await getNumberReport(orgId, connectionId, { days });
    res.json({ success: true, report });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, error: err.message });
    }
    console.error('[NumberReportController] error', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
