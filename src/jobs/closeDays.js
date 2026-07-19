// src/jobs/closeDays.js
const cron = require('node-cron');
const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');
const ruleManagementService = require('../services/ruleManagementService');
const dailyExecutionService = require('../services/dailyExecutionService');
const notificationService = require('../services/notificationService');
const jobLogger = require('../utils/joblogger');

const DIRECT_NOTIFICATION_ENABLED =
  process.env.DIRECT_NOTIFICATION_ENABLED === "true";

// Run every minute
cron.schedule('* * * * *', async () => {
  const currentTimeUTC = new Date().toISOString();
  
  try {
    console.log(`[CloseDays] Checking at ${currentTimeUTC}`);
    
    // Get users whose day ends now
    const users = await ruleManagementService.getUsersDayEnd(currentTimeUTC);
    
    if (users.length === 0) {
      return;
    }
    
    console.log(`[CloseDays] Closing days for ${users.length} users`);
    
    for (const user of users) {
      await closeDayForUser(user, currentTimeUTC);
    }
    
  } catch (error) {
    console.error('[CloseDays] Error:', error.message);
  }
});

async function closeDayForUser(user, currentTimeUTC) {
  const executionId = await jobLogger.logStart('CLOSE_DAY', user.userId, new Date().toISOString().split('T')[0]);
  
  try {
    const userId = user.userId;
    
    console.log(`[CloseDays] Processing user ${userId}`);
    
    // Step 1: Get today's day
    const today = await dailyExecutionService.getTodayDay(userId);
    
    // Step 2: Check if already closed
    if (today.status === 'CLOSED') {
      console.log(`[CloseDays] Day ${today.dayId} already closed for user ${userId}`);
      await jobLogger.logSuccess(executionId, { skipped: true, reason: 'Already closed' });
      return;
    }
    
    // Step 3: Close the day
    const closeResult = await dailyExecutionService.closeDay(today.dayId, currentTimeUTC);
    
    console.log(`[CloseDays] ✓ Day ${closeResult.dayId} closed for user ${userId} - Result: ${closeResult.result}`);
    
    // 🔴 STEP 4: QUEUE FOR EVALUATION (NEW!)
    if (closeResult.readyForEvaluation) {
      try {
        await sequelize.query(
          `INSERT INTO EVALUATION_QUEUE
           (DAYID, USERID, DAYDATE, CLOSEDAT, EVALUATIONSTATUS, EVALUATIONATTEMPTS)
           VALUES (:dayId, :userId, :dayDate, :closedAt, 'PENDING', 0)`,
          {
            replacements: {
              dayId: closeResult.dayId,
              userId,
              dayDate: closeResult.dayDate,
              closedAt: currentTimeUTC
            },
            type: QueryTypes.INSERT
          }
        );
        
        console.log(`[CloseDays] ✓ Day ${closeResult.dayId} queued for evaluation`);
        
      } catch (queueError) {
        console.error(`[CloseDays] Failed to queue evaluation:`, queueError.message);
      }
    }
    
    // Step 5: Send day-closed notification (direct mode only)
    if (DIRECT_NOTIFICATION_ENABLED) {
      try {
        await notificationService.sendDayClosedNotification(
          userId,
          closeResult.dayNumber || 0,
          closeResult.completedRules || 0,
          closeResult.totalRules || 0,
        );
        console.log(`[CloseDays] Notification sent to user ${userId} (direct)`);
      } catch (notifError) {
        console.error(`[CloseDays] Failed to send notification (direct):`, notifError.message);
      }
    }

    // Step 6: Log success
    await jobLogger.logSuccess(executionId, {
      dayId: closeResult.dayId,
      result: closeResult.result,
      queuedForEvaluation: closeResult.readyForEvaluation
    });
    
  } catch (error) {
    console.error(`[CloseDays] Failed for user ${user.userId}:`, error.message);
    await jobLogger.logFailure(executionId, 'CLOSE_FAILED', error.message);
  }
}

console.log('[CloseDays] Job scheduled - runs every minute');