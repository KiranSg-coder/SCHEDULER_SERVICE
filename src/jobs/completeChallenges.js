// src/jobs/completeChallenges.js
// Marks ACTIVE rule sets whose final day closed as COMPLETED, then
// auto-promotes the next tier (NEEDSSETUP=1). Day creation stops until setup.
const cron = require('node-cron');
const ruleManagementService = require('../services/ruleManagementService');
const jobLogger = require('../utils/joblogger');

cron.schedule('* * * * *', async () => {
  const executionId = await jobLogger.logStart('COMPLETE_CHALLENGES');

  try {
    console.log('[CompleteChallenges] Checking for expired challenges');

    const result = await ruleManagementService.completeExpiredRulesets();

    if (result.totalCompleted > 0) {
      console.log(
        `[CompleteChallenges] ✓ Completed ${result.totalCompleted} challenges`,
      );

      await jobLogger.logSuccess(executionId, {
        totalCompleted: result.totalCompleted,
        completedChallenges: result.completedChallenges,
      });
    } else {
      await jobLogger.logSuccess(executionId, { totalCompleted: 0 });
    }
  } catch (error) {
    console.error('[CompleteChallenges] Error:', error.message);
    await jobLogger.logFailure(executionId, 'COMPLETE_FAILED', error.message);
  }
});

console.log('[CompleteChallenges] Job scheduled - runs every minute');
