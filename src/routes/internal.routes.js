// src/routes/internal.routes.js
const express = require('express');
const router = express.Router();
const {
  getHealthStatus,
  getJobHistory,
  getPendingModeChanges,
} = require('../controllers/monitoring.controller');

router.get('/health', getHealthStatus);
router.get('/jobs/history', getJobHistory);
router.get('/mode-changes/pending', getPendingModeChanges);

module.exports = router;