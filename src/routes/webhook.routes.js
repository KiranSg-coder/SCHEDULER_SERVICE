// src/routes/webhook.routes.js
const express = require('express');
const router = express.Router();
const { receiveModeChange } = require('../controllers/webhook.controller');
const { handleEvent } = require('../controllers/eventWebhook.controller');

router.post('/mode-change', receiveModeChange);
router.post('/event', handleEvent);

module.exports = router;