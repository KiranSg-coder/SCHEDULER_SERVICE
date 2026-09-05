// src/jobs/closeDays.js
//
// V2 changes:
//   • Closes the day the boundary actually refers to (RULE_SET.CURRENTDAYID),
//     falling back to "today" only when the pointer is missing. Closing
//     "today's day" broke as soon as day creation caught up on a backlog,
//     because the due boundary and the wall-clock day were different days.
//   • Overlap guard so a slow tick cannot double-close.
const cron = require('node-cron');
const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');
const ruleManagementService = require('../services/ruleManagementService');
const dailyExecutionService = require('../services/dailyExecutionService');
const notificationService = require('../services/notificationService');
const jobLogger = require('../utils/joblogger');

const DIRECT_NOTIFICATION_ENABLED =
  process.env.DIRECT_NOTIFICATION_ENABLED === 'true';

let running = false;

cron.schedule('* * * * *', async () => {
  if (running) {
    console.log('[CloseDays] Previous tick still running — skipping');
    return;
  }
  running = true;

  const currentTimeUTC = new Date().toISOString();

  try {
    const users = await ruleManagementService.getUsersDayEnd(currentTimeUTC);
    if (!users.length) return;

    console.log(`[CloseDays] ${users.length} user(s) due at ${currentTimeUTC}`);

    for (const user of users) {
      await closeDayForUser(user, currentTimeUTC);
    }
  } catch (error) {
    console.error('[CloseDays] Error:', error.message);
  } finally {
    running = false;
  }
});

async function closeDayForUser(user, currentTimeUTC) {
  const userId = user.userId;
  const targetDate =
    user.targetDayDate || new Date().toISOString().split('T')[0];
  const executionId = await jobLogger.logStart('CLOSE_DAY', userId, targetDate);

  try {
    // Prefer the explicit pointer set by USP_UPDATE_NEXT_DAY_BOUNDARIES.
    let dayId = user.currentDayId ?? null;
    let dayStatus = null;

    if (!dayId) {
      const today = await dailyExecutionService.getTodayDay(userId);
      if (!today) {
        console.log(`[CloseDays] user ${userId}: no day to close`);
        await jobLogger.logSuccess(executionId, { skipped: true, reason: 'NO_DAY' });
        return;
      }
      dayId = today.dayId;
      dayStatus = today.status;
    }

    if (dayStatus === 'CLOSED') {
      await jobLogger.logSuccess(executionId, { skipped: true, reason: 'ALREADY_CLOSED' });
      return;
    }

    const closeResult = await dailyExecutionService.closeDay(dayId, currentTimeUTC);

    console.log(
      `[CloseDays] user ${userId}: day ${closeResult.dayId} closed — ${closeResult.result}`,
    );

    if (closeResult.readyForEvaluation) {
      try {
        // Guard against a duplicate queue row if a tick overlaps.
        await sequelize.query(
          `IF NOT EXISTS (
               SELECT 1 FROM EVALUATION_QUEUE
               WHERE DAYID = :dayId AND EVALUATIONSTATUS IN ('PENDING','PROCESSING')
           )
           INSERT INTO EVALUATION_QUEUE
             (DAYID, USERID, DAYDATE, CLOSEDAT, EVALUATIONSTATUS, EVALUATIONATTEMPTS)
           VALUES (:dayId, :userId, :dayDate, :closedAt, 'PENDING', 0)`,
          {
            replacements: {
              dayId: closeResult.dayId,
              userId,
              dayDate: closeResult.dayDate,
              closedAt: currentTimeUTC,
            },
            type: QueryTypes.INSERT,
          },
        );
        console.log(`[CloseDays] day ${closeResult.dayId} queued for evaluation`);
      } catch (queueError) {
        console.error('[CloseDays] Failed to queue evaluation:', queueError.message);
      }
    }

    if (DIRECT_NOTIFICATION_ENABLED) {
      try {
        await notificationService.sendDayClosedNotification(
          userId,
          closeResult.dayNumber || 0,
          closeResult.completedRules || 0,
          closeResult.totalRules || 0,
        );
      } catch (notifError) {
        console.error('[CloseDays] Notification failed:', notifError.message);
      }
    }

    await jobLogger.logSuccess(executionId, {
      dayId: closeResult.dayId,
      result: closeResult.result,
      queuedForEvaluation: closeResult.readyForEvaluation,
    });
  } catch (error) {
    console.error(`[CloseDays] Failed for user ${userId}:`, error.message);
    await jobLogger.logFailure(executionId, 'CLOSE_FAILED', error.message);
  }
}

console.log('[CloseDays] Job scheduled — every minute');
