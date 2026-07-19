// src/jobs/activateRulesets.js
const cron = require('node-cron');
const ruleManagementService = require('../services/ruleManagementService');
const jobLogger = require('../utils/joblogger');

// Run every minute
cron.schedule('* * * * *', async () => {
  const executionId = await jobLogger.logStart('ACTIVATE_RULESET');
  
  try {
    console.log('[ActivateRulesets] Checking for pending rulesets');
    
    const result = await ruleManagementService.activatePendingRulesets();
    
    if (result.totalActivated > 0) {
      console.log(`[ActivateRulesets] ✓ Activated ${result.totalActivated} rulesets`);
      
      await jobLogger.logSuccess(executionId, {
        totalActivated: result.totalActivated,
        activatedRulesets: result.activatedRulesets,
      });
    } else {
      await jobLogger.logSuccess(executionId, { totalActivated: 0 });
    }
    
  } catch (error) {
    console.error('[ActivateRulesets] Error:', error.message);
    await jobLogger.logFailure(executionId, 'ACTIVATE_FAILED', error.message);
  }
});

console.log('[ActivateRulesets] Job scheduled - runs every minute');