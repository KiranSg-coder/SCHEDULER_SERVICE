// src/jobs/sendEveningNudges.js
const cron = require('node-cron');
const dailyExecutionService = require('../services/dailyExecutionService');
const notificationService = require('../services/notificationService');
const jobLogger = require('../utils/joblogger');

// Run every minute
cron.schedule('* * * * *', async () => {
  const currentTimeUTC = new Date().toISOString();

  try {
    const candidates = await dailyExecutionService.getNudgeCandidates(currentTimeUTC);

    if (candidates.length === 0) {
      return;
    }

    console.log(`[EveningNudge] Sending nudges to ${candidates.length} users`);

    for (const user of candidates) {
      const executionId = await jobLogger.logStart(
        'EVENING_NUDGE',
        user.userId,
        new Date().toISOString().split('T')[0]
      );

      try {
        await notificationService.sendEveningNudge(
          user.userId,
          user.remainingRules,
          user.dayNumber
        );

        console.log(`[EveningNudge] Nudge sent to user ${user.userId} (${user.remainingRules} rules remaining)`);

        await jobLogger.logSuccess(executionId, {
          userId: user.userId,
          dayId: user.dayId,
          remainingRules: user.remainingRules,
        });
      } catch (error) {
        console.error(`[EveningNudge] Failed for user ${user.userId}:`, error.message);
        await jobLogger.logFailure(executionId, 'NUDGE_FAILED', error.message);
      }
    }
  } catch (error) {
    console.error('[EveningNudge] Error:', error.message);
  }
});

console.log('[EveningNudge] Job scheduled - runs every minute');
