// src/jobs/createDailyInstances.js
//
// Creates one USERDAY per user per scheduled boundary.
//
// V2 changes:
//   • The lock and DAYDATE are keyed on the BOUNDARY's local date
//     (user.targetDayDate), not wall-clock UTC. Keying on "today" meant a
//     backlog collapsed onto a single date and could never drain.
//   • Atomic claim via USP_CLAIM_DAY_LOCK; a failed attempt deletes the lock
//     so the next tick genuinely retries (the old code logged that it would,
//     but USP_CHECK_DAY_LOCK ignored RELEASEDAT so it never could).
//   • Per-user catch-up loop drains a backlog instead of one day per tick.
//   • ENDDATE guard: never create a day past the challenge window; the
//     completeChallenges job owns that transition.
//   • DAYNUMBER is challenge-relative, not a lifetime count.
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
  process.env.DIRECT_NOTIFICATION_ENABLED === 'true';

/** Max backlog days drained per user per tick. Bounds a cold start. */
const MAX_CATCHUP_DAYS = Number(process.env.MAX_CATCHUP_DAYS_PER_TICK || 30);

let running = false;

cron.schedule('* * * * *', async () => {
  if (running) {
    console.log('[CreateDays] Previous tick still running — skipping');
    return;
  }
  running = true;

  const currentTimeUTC = new Date().toISOString();

  try {
    const users = await ruleManagementService.getUsersDayStart(currentTimeUTC);

    if (!users.length) return;

    console.log(`[CreateDays] ${users.length} user(s) due at ${currentTimeUTC}`);

    for (const user of users) {
      await drainUserBacklog(user);
    }
  } catch (error) {
    console.error('[CreateDays] Error:', error.message);
  } finally {
    running = false;
  }
});

/**
 * Create every day this user is owed, oldest first, until they are current.
 * Each iteration re-reads the boundary from Rule Management so we always act
 * on committed state.
 */
async function drainUserBacklog(user) {
  let current = user;

  for (let i = 0; i < MAX_CATCHUP_DAYS; i += 1) {
    const targetDayDate = resolveTargetDayDate(current);
    if (!targetDayDate) {
      console.error(
        `[CreateDays] user ${current.userId}: no targetDayDate — skipping. ` +
          'Apply RULE_MANAGEMENT/sql/15_PROGRESSION_V2.sql.',
      );
      return;
    }

    // ENDDATE guard — the challenge window is over; completeChallenges owns it.
    if (current.endDate && targetDayDate > current.endDate) {
      console.log(
        `[CreateDays] user ${current.userId}: ${targetDayDate} is past challenge end ` +
          `${current.endDate} — leaving to completeChallenges`,
      );
      return;
    }

    const outcome = await createDayForUser(current, targetDayDate);
    if (outcome !== 'CREATED') return;

    // Still behind? Re-read and go again.
    const refreshed = await ruleManagementService
      .getUsersDayStart(new Date().toISOString())
      .catch(() => []);
    const next = refreshed.find((u) => u.userId === current.userId);
    if (!next) return;
    current = next;
  }

  console.warn(
    `[CreateDays] user ${user.userId}: hit MAX_CATCHUP_DAYS (${MAX_CATCHUP_DAYS}) — ` +
      'will continue next tick',
  );
}

/** Local calendar date of the due boundary. */
function resolveTargetDayDate(user) {
  if (user.targetDayDate) return String(user.targetDayDate).slice(0, 10);
  // Defensive fallback for a pre-migration Rule Management.
  if (user.nextDayStartUTC) return new Date(user.nextDayStartUTC).toISOString().slice(0, 10);
  return null;
}

/**
 * @returns {Promise<'CREATED'|'SKIPPED'|'FAILED'>}
 */
async function createDayForUser(user, dayDate) {
  const userId = user.userId;
  const executionId = await jobLogger.logStart('CREATE_DAY', userId, dayDate);
  let claimed = false;

  try {
    // ---- Step 1: atomic claim -------------------------------------------
    const claim = await lockManager.claimDay(userId, dayDate, 'scheduler');

    if (claim.alreadyCreated) {
      console.log(
        `[CreateDays] user ${userId}: day ${dayDate} already exists (dayId ${claim.existingDayId})`,
      );
      // Boundary may still be stale — nudge it so the loop can progress.
      await advanceBoundaries(userId, claim.existingDayId);
      await jobLogger.logSuccess(executionId, { skipped: true, reason: 'ALREADY_CREATED' });
      return 'SKIPPED';
    }

    if (claim.inFlight) {
      console.log(`[CreateDays] user ${userId}: day ${dayDate} claimed by another worker`);
      await jobLogger.logSuccess(executionId, { skipped: true, reason: 'IN_FLIGHT' });
      return 'SKIPPED';
    }

    if (!claim.claimed) {
      await jobLogger.logSuccess(executionId, { skipped: true, reason: 'NOT_CLAIMED' });
      return 'SKIPPED';
    }

    claimed = true;

    // ---- Step 2: pending mode change ------------------------------------
    const pendingModeChange = await sequelize.query(
      `EXEC USP_GET_PENDING_MODE_CHANGE
        @USERID = :userId,
        @EFFECTIVEDATE = :dayDate`,
      { replacements: { userId, dayDate }, type: QueryTypes.SELECT },
    );

    let mode = 'STANDARD';
    let minimumModeReason = null;

    if (pendingModeChange.length > 0) {
      mode = pendingModeChange[0].NEWMODE;
      minimumModeReason = pendingModeChange[0].REASON;
      console.log(`[CreateDays] user ${userId}: mode change -> ${mode} for ${dayDate}`);
    }

    if (mode === 'MINIMUM' && !minimumModeReason) {
      minimumModeReason = 'FAILURE_THRESHOLD';
    }

    // ---- Step 3: active ruleset + rules ---------------------------------
    const ruleset = await ruleManagementService.getActiveRuleset(userId);
    const dailyRules = transformRulesForDaily(ruleset, mode);

    if (dailyRules.length === 0) {
      throw new Error(
        `Ruleset ${ruleset?.ruleSetId} produced 0 rules for mode ${mode} — refusing to ` +
          'create an empty day (an empty day auto-passes at close).',
      );
    }

    // ---- Step 4: challenge-relative day number --------------------------
    const dayNumber = await calculateDayNumber(userId, ruleset?.startDate);

    // ---- Step 5: create ---------------------------------------------------
    const dayResult = await dailyExecutionService.createDay({
      userId,
      ruleSetId: ruleset.ruleSetId,
      versionNumber: ruleset.version,
      dayDate,
      dayNumber,
      mode,
      startedAt: user.nextDayStartUTC || new Date().toISOString(),
      rules: dailyRules,
      minimumModeReason,
    });

    console.log(
      `[CreateDays] user ${userId}: day ${dayNumber} created for ${dayDate} ` +
        `(dayId ${dayResult.dayId}, mode ${mode}, ${dailyRules.length} rules)`,
    );

    // ---- Step 6: release + advance boundaries ---------------------------
    await lockManager.releaseLock(userId, dayDate, dayResult.dayId);
    claimed = false;

    await advanceBoundaries(userId, dayResult.dayId);

    // ---- Step 7: mark mode change processed -----------------------------
    if (pendingModeChange.length > 0) {
      await sequelize.query(
        `EXEC USP_MARK_MODE_CHANGE_PROCESSED
          @USERID = :userId,
          @EFFECTIVEDATE = :dayDate,
          @CREATEDDAYID = :dayId`,
        {
          replacements: { userId, dayDate, dayId: dayResult.dayId },
          type: QueryTypes.SELECT,
        },
      );
    }

    // ---- Step 8: notifications (non-fatal) ------------------------------
    let notificationSent = false;
    if (DIRECT_NOTIFICATION_ENABLED) {
      try {
        await notificationService.sendDayStartNotification(
          userId,
          dayNumber,
          mode,
          minimumModeReason,
        );
        notificationSent = true;
      } catch (e) {
        console.error(`[CreateDays] day-start notification failed:`, e.message);
      }
    }

    try {
      const previousDay = await dailyExecutionService.getPreviousDayResult(userId, dayDate);
      if (previousDay && previousDay.result === 'FAIL') {
        await notificationService.sendPreviousDayIncompleteNotification(
          userId,
          Number(previousDay.dayNumber) || 0,
          Number(previousDay.completedRules ?? 0) || 0,
          Number(previousDay.totalRules ?? 0) || 0,
        );
      }
    } catch (e) {
      console.error(`[CreateDays] previous-day ack failed:`, e.message);
    }

    // ---- Step 9: guided learning plan (non-fatal) -----------------------
    if (mode === 'STANDARD') {
      try {
        const LEARNING_SERVICE_URL =
          process.env.LEARNING_SERVICE_URL || 'http://localhost:6009';
        await axios.post(
          `${LEARNING_SERVICE_URL}/internal/plan/generate`,
          { userId, planDate: dayDate, dayId: dayResult.dayId },
          {
            headers: { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY },
            timeout: 10000,
          },
        );
      } catch (learningError) {
        const code = learningError.response?.data?.error?.code;
        const benign = [
          'NOT_ENROLLED',
          'PLAN_EXISTS',
          'NO_NON_NEGOTIABLES',
          'NO_ENROLLMENTS',
        ];
        if (!benign.includes(code)) {
          console.error(
            `[CreateDays] learning plan failed for user ${userId}:`,
            learningError.message,
          );
        }
      }
    }

    await jobLogger.logSuccess(executionId, {
      dayId: dayResult.dayId,
      dayDate,
      dayNumber,
      mode,
      ruleCount: dailyRules.length,
      notificationSent,
    });

    return 'CREATED';
  } catch (error) {
    console.error(`[CreateDays] user ${userId} / ${dayDate} failed:`, error.message);
    if (error.response) {
      console.error(`[CreateDays] upstream ${error.response.status}:`,
        JSON.stringify(error.response.data));
    }

    // Delete the claim so the next tick retries. This is the AR-1 fix: the old
    // release only stamped RELEASEDAT and USP_CHECK_DAY_LOCK ignored it, so a
    // failed day was permanently unrecoverable.
    if (claimed) {
      try {
        await lockManager.releaseLock(userId, dayDate, null);
        console.log(`[CreateDays] claim released for retry (user ${userId}, ${dayDate})`);
      } catch (lockError) {
        console.error(`[CreateDays] failed to release claim:`, lockError.message);
      }
    }

    await jobLogger.logFailure(executionId, 'CREATE_FAILED', error.message);
    return 'FAILED';
  }
}

async function advanceBoundaries(userId, createdDayId) {
  try {
    await axios.post(
      `${process.env.RULE_MANAGEMENT_URL}/internal/ruleset/update-boundaries`,
      { userId, createdDayId },
      { headers: { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY }, timeout: 8000 },
    );
  } catch (e) {
    console.error(`[CreateDays] boundary update failed for user ${userId}:`, e.message);
    throw e; // the loop must not spin on a stale boundary
  }
}

/**
 * Day number within the CURRENT challenge (CP-11). Previously this counted
 * every USERDAY the user had ever had, so day 1 of Builder displayed as "Day 15".
 */
async function calculateDayNumber(userId, challengeStartDate) {
  try {
    if (challengeStartDate) {
      const startDate = String(challengeStartDate).slice(0, 10);
      const rows = await sequelize.query(
        `SELECT COUNT(*) AS DaysInChallenge
         FROM [DAILY_EXECUTION].[dbo].[USERDAY]
         WHERE USERID = :userId AND DAYDATE > :startDate`,
        { replacements: { userId, startDate }, type: QueryTypes.SELECT },
      );
      return (rows[0]?.DaysInChallenge || 0) + 1;
    }

    const rows = await sequelize.query(
      `SELECT COUNT(*) AS TotalDays
       FROM [DAILY_EXECUTION].[dbo].[USERDAY]
       WHERE USERID = :userId`,
      { replacements: { userId }, type: QueryTypes.SELECT },
    );
    return (rows[0]?.TotalDays || 0) + 1;
  } catch (error) {
    console.error('[CreateDays] day-number calculation failed:', error.message);
    return 1;
  }
}

console.log('[CreateDays] Job scheduled — every minute, with backlog catch-up');
