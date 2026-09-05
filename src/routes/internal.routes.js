// src/routes/internal.routes.js
const express = require('express');
const router = express.Router();
const {
  getHealthStatus,
  getJobHistory,
  getPendingModeChanges,
} = require('../controllers/monitoring.controller');
const { runHealthCheck } = require('../jobs/progressionHealthCheck');
const { reconcileOnce } = require('../jobs/reconcileModeChanges');

router.get('/health', getHealthStatus);
router.get('/jobs/history', getJobHistory);
router.get('/mode-changes/pending', getPendingModeChanges);

/** On-demand progression detectors (same query the hourly job runs). */
router.get('/progression/health', async (req, res) => {
  try {
    const summary = await runHealthCheck();
    return res.status(200).json({ success: true, data: summary });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: { code: 'HEALTH_CHECK_FAILED', message: error.message },
    });
  }
});

/** On-demand replay of undelivered mode changes. Idempotent. */
router.post('/mode-changes/reconcile', async (req, res) => {
  try {
    const result = await reconcileOnce();
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: { code: 'RECONCILE_FAILED', message: error.message },
    });
  }
});

module.exports = router;
