// src/jobs/createDailyInstances.js
const cron = require('node-cron');
const axios = require('axios');
const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');
const ruleManagementService = require('../services/ruleManagementService');
const dailyExecutionService = require('../services/dailyExecutionService');
const notificationService = require('../services/notificationService');
const jobLogger = require('../utils/joblogger');
const lockManager = require('../utils/lockManager');
const { transformRulesForDaily } = require('../utils/ruleTransformer');

const DIRECT_NOTIFICATION_ENABLED =
  process.env.DIRECT_NOTIFICATION_ENABLED === "true";

// Run every minute
cron.schedule('* * * * *', async () => {
  const currentTimeUTC = new Date().toISOString();
  
  try {
    console.log(`[CreateDays] Checking at ${currentTimeUTC}`);
    
    // Get users whose day starts now
    const users = await ruleManagementService.getUsersDayStart(currentTimeUTC);
    
    if (users.length === 0) {
      return; // No users to process
    }
    
    console.log(`[CreateDays] Creating days for ${users.length} users`);
    
    for (const user of users) {
      await createDayForUser(user, currentTimeUTC);
    }
    
  } catch (error) {
    console.error('[CreateDays] Error:', error.message);
  }
});

async function createDayForUser(user, currentTimeUTC) {
  const executionId = await jobLogger.logStart('CREATE_DAY', user.userId, new Date().toISOString().split('T')[0]);
  let lockCreated = false;
  let notificationSent = false;
  
  try {
    const userId = user.userId;
    const today = new Date().toISOString().split('T')[0];
    
    console.log(`[CreateDays] Processing user ${userId} for date ${today}`);
    
    // Step 1: Check lock
    const lockCheck = await lockManager.checkLock(userId, today);
    console.log(`[CreateDays] Lock check result for user ${userId}:`, JSON.stringify(lockCheck));
    if (lockCheck.LockExists) {
      console.log(`[CreateDays] Day already exists for user ${userId} — skipping (stale lock or day already created)`);
      await jobLogger.logSuccess(executionId, { skipped: true, reason: 'Day already exists' });
      return;
    }
    
    // Step 2: Create lock
    const lockId = await lockManager.createLock(userId, today, 'scheduler');
    lockCreated = true;
    console.log(`[CreateDays] Lock created for user ${userId} (lockId: ${lockId})`);
    
    // Step 3: Check for pending mode change
    const pendingModeChange = await sequelize.query(
      `EXEC USP_GET_PENDING_MODE_CHANGE 
        @USERID = :userId,
        @EFFECTIVEDATE = :today`,
      {
        replacements: { userId, today },
        type: QueryTypes.SELECT,
      }
    );
    console.log(`[CreateDays] Pending mode change rows for user ${userId} on ${today}:`, JSON.stringify(pendingModeChange));
    
    let mode = 'STANDARD';
    let minimumModeReason = null;
    
    if (pendingModeChange.length > 0) {
      mode = pendingModeChange[0].NEWMODE;
      minimumModeReason = pendingModeChange[0].REASON;
      console.log(`[CreateDays] ⚠️ Mode change detected: ${mode} for user ${userId}`);
    }

    if (mode === 'MINIMUM' && !minimumModeReason) {
      minimumModeReason = 'FAILURE_THRESHOLD';
      console.log(`[CreateDays] minimumModeReason missing; defaulting to ${minimumModeReason}`);
    }
    
    // Step 4: Get active ruleset
    console.log(`[CreateDays] Fetching active ruleset for user ${userId} from ${process.env.RULE_MANAGEMENT_URL}/ruleset/active`);
    const ruleset = await ruleManagementService.getActiveRuleset(userId);
    console.log(`[CreateDays] Active ruleset for user ${userId}: ruleSetId=${ruleset.ruleSetId}, version=${ruleset.version}, rules=${ruleset.standardRules?.length}`);
    
    // Step 5: Transform rules based on mode
    const dailyRules = transformRulesForDaily(ruleset, mode);
    console.log(`[CreateDays] Transformed ${dailyRules.length} rules for mode=${mode}`);
    
    // Step 6: Calculate day number
    const dayNumber = await calculateDayNumber(userId);
    console.log(`[CreateDays] Day number for user ${userId}: ${dayNumber}`);
    
    // Step 7: Create day
    const createDayPayload = {
      userId,
      ruleSetId: ruleset.ruleSetId,
      versionNumber: ruleset.version,
      dayDate: today,
      dayNumber,
      mode,
      startedAt: currentTimeUTC,
      rules: dailyRules,
      minimumModeReason,
    };
    console.log(`[CreateDays] Calling Daily Execution: POST ${process.env.DAILY_EXECUTION_URL}/internal/day/create`);
    console.log(`[CreateDays] Payload:`, JSON.stringify(createDayPayload, null, 2));
    
    const dayResult = await dailyExecutionService.createDay(createDayPayload);
    console.log(`[CreateDays] ✓ Day ${dayNumber} created for user ${userId} (dayId: ${dayResult.dayId}, mode: ${mode})`);
    
    // Step 8: Release lock
    await lockManager.releaseLock(userId, today, dayResult.dayId);
    console.log(`[CreateDays] Lock released for user ${userId}`);
    
    // Step 9: Update next day boundaries
    try {
      await axios.post(
        `${process.env.RULE_MANAGEMENT_URL}/internal/ruleset/update-boundaries`,
        { userId, createdDayId: dayResult.dayId },
        { headers: { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY } }
      );
      console.log(`[CreateDays] ✓ Next day boundaries updated for user ${userId}`);
    } catch (boundaryError) {
      console.error(`[CreateDays] Failed to update boundaries:`, boundaryError.message);
    }

    // Step 10: Mark mode change as processed (if applicable)
    if (pendingModeChange.length > 0) {
      await sequelize.query(
        `EXEC USP_MARK_MODE_CHANGE_PROCESSED 
          @USERID = :userId,
          @EFFECTIVEDATE = :today,
          @CREATEDDAYID = :dayId`,
        {
          replacements: { userId, today, dayId: dayResult.dayId },
          type: QueryTypes.UPDATE,
        }
      );
      console.log(`[CreateDays] Mode change marked as processed for user ${userId}`);
    }
    
    // Step 11: Send notification
    if (DIRECT_NOTIFICATION_ENABLED) {
      try {
        await notificationService.sendDayStartNotification(
          userId,
          dayNumber,
          mode,
          minimumModeReason,
        );
        notificationSent = true;
        console.log(`[CreateDays] ✓ Notification sent to user ${userId} (direct)`);
      } catch (notificationError) {
        console.error(`[CreateDays] Failed to send notification (direct):`, notificationError.message);
      }
    }

    // Step 12: Check previous day result and send ack if incomplete
    try {
      const previousDay = await dailyExecutionService.getPreviousDayResult(userId, today);
      console.log(
        `[CreateDays][PREVIOUS_DAY_INCOMPLETE] user ${userId} previousDay=`,
        JSON.stringify(previousDay),
      );
      if (previousDay && previousDay.result === 'FAIL') {
        const prevNum = Number(previousDay.dayNumber) || 0;
        const completed = Number(previousDay.completedRules ?? 0) || 0;
        const total = Number(previousDay.totalRules ?? 0) || 0;
        console.log(
          `[CreateDays] Previous day FAIL for user ${userId} — sending PREVIOUS_DAY_INCOMPLETE (day ${prevNum}, ${completed}/${total})`,
        );
        await notificationService.sendPreviousDayIncompleteNotification(
          userId,
          prevNum,
          completed,
          total,
        );
      }
    } catch (prevDayError) {
      console.error(`[CreateDays] Failed to check/send previous day ack:`, prevDayError.message);
    }

    // Step 12b: Generate learning plan only when non-negotiables exist for the day (same payload as createDay)
    if (mode === 'STANDARD' && dailyRules.length > 0) {
      try {
        const LEARNING_SERVICE_URL = process.env.LEARNING_SERVICE_URL || 'http://localhost:6007';
        await axios.post(
          `${LEARNING_SERVICE_URL}/internal/plan/generate`,
          { userId, planDate: today, dayId: dayResult.dayId },
          {
            headers: { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY },
            timeout: 10000,
          }
        );
        console.log(`[CreateDays] ✓ Learning plan generated for user ${userId}`);
      } catch (learningError) {
        // Non-fatal: no guided learning, plan exists, no checklist, etc.
        const code = learningError.response?.data?.error?.code;
        if (
          code === 'NOT_ENROLLED' ||
          code === 'PLAN_EXISTS' ||
          code === 'NO_NON_NEGOTIABLES' ||
          code === 'NO_ENROLLMENTS'
        ) {
          console.log(`[CreateDays] Learning plan skipped for user ${userId}: ${code}`);
        } else {
          console.error(`[CreateDays] Learning plan generation failed for user ${userId}:`, learningError.message);
        }
      }
    } else if (mode === 'STANDARD' && dailyRules.length === 0) {
      console.log(`[CreateDays] Learning plan skipped for user ${userId}: no non-negotiable rules in payload`);
    }

    // Step 13: Log success
    await jobLogger.logSuccess(executionId, {
      dayId: dayResult.dayId,
      dayNumber,
      mode,
      notificationSent
    });
    
  } catch (error) {
    console.error(`[CreateDays] ❌ Failed for user ${user.userId}:`, error.message);
    if (error.response) {
      console.error(`[CreateDays] Response status: ${error.response.status}`);
      console.error(`[CreateDays] Response data:`, JSON.stringify(error.response.data));
    }
    
    // Release the stale lock so the next tick can retry
    if (lockCreated) {
      try {
        const today = new Date().toISOString().split('T')[0];
        await lockManager.releaseLock(user.userId, today, null);
        console.log(`[CreateDays] Stale lock released for user ${user.userId} after failure`);
      } catch (lockError) {
        console.error(`[CreateDays] Failed to release stale lock for user ${user.userId}:`, lockError.message);
      }
    }
    
    await jobLogger.logFailure(executionId, 'CREATE_FAILED', error.message);
  }
}

async function calculateDayNumber(userId) {
  try {
    const result = await sequelize.query(
      `SELECT COUNT(*) AS TotalDays 
       FROM [DAILY_EXECUTION].[dbo].[USERDAY]
       WHERE USERID = :userId`,
      {
        replacements: { userId },
        type: QueryTypes.SELECT,
      }
    );
    return (result[0]?.TotalDays || 0) + 1;
  } catch (error) {
    console.error(`[CreateDays] Failed to calculate day number:`, error.message);
    return 1;
  }
}

console.log('[CreateDays] Job scheduled - runs every minute');