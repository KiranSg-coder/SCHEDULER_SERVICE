// src/jobs/reconcileModeChanges.js
//
// Mode changes are decided by USP_EVALUATE_DAY (Discipline DB) and then shipped
// to PENDING_MODE_CHANGES (Scheduler DB) by a fire-and-log HTTP call. If that
// call fails there is no retry, and USP_EVALUATE_DAY is idempotent so it will
// never re-emit — the user's mode history says MINIMUM while their next day is
// built STANDARD. That is the root cause of "Minimum Mode doesn't always work".
//
// MODECHANGEHISTORY is already a durable, committed record of the decision, so
// this job simply replays anything that never landed. USP_STORE_MODE_CHANGE is
// idempotent on MODECHANGEID, so replay is safe.
const cron = require('node-cron');
const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');
const jobLogger = require('../utils/joblogger');

const ENABLED = process.env.MODE_CHANGE_RECONCILE_ENABLED !== 'false';
const LOOKBACK_DAYS = Number(process.env.MODE_CHANGE_LOOKBACK_DAYS || 30);
const CRON_EXPR = process.env.MODE_CHANGE_RECONCILE_CRON || '*/5 * * * *';

let running = false;

async function reconcileOnce() {
  const executionId = await jobLogger.logStart('RECONCILE_MODE_CHANGES');

  try {
    // Decisions with no corresponding pending row.
    const undelivered = await sequelize.query(
      `SELECT
          MCH.MODECHANGEID,
          MCH.USERID,
          MCH.NEWMODE,
          MCH.PREVIOUSMODE,
          MCH.CHANGEREASON,
          MCH.EFFECTIVEDATE
       FROM DISCIPLINE_RULE_ENGINE.dbo.MODECHANGEHISTORY MCH
       WHERE MCH.EFFECTIVEDATE >= DATEADD(DAY, -:lookback, CAST(SYSUTCDATETIME() AS DATE))
         AND NOT EXISTS (
             SELECT 1 FROM dbo.PENDING_MODE_CHANGES P
             WHERE P.MODECHANGEID = MCH.MODECHANGEID
         )
         AND NOT EXISTS (
             -- Already applied: a day exists on/after the effective date in that mode.
             SELECT 1 FROM DAILY_EXECUTION.dbo.USERDAY UD
             WHERE UD.USERID = MCH.USERID
               AND UD.DAYDATE >= MCH.EFFECTIVEDATE
               AND UD.MODE = MCH.NEWMODE
         )
       ORDER BY MCH.EFFECTIVEDATE ASC, MCH.MODECHANGEID ASC`,
      { replacements: { lookback: LOOKBACK_DAYS }, type: QueryTypes.SELECT },
    );

    if (!undelivered.length) {
      await jobLogger.logSuccess(executionId, { replayed: 0 });
      return { replayed: 0 };
    }

    console.warn(
      `[ReconcileModeChanges] ${undelivered.length} undelivered mode change(s) — replaying`,
    );

    let replayed = 0;

    for (const change of undelivered) {
      try {
        const effectiveDate = String(change.EFFECTIVEDATE).slice(0, 10);

        await sequelize.query(
          `EXEC USP_STORE_MODE_CHANGE
            @USERID = :userId,
            @NEWMODE = :newMode,
            @PREVIOUSMODE = :previousMode,
            @REASON = :reason,
            @EFFECTIVEDATE = :effectiveDate,
            @MODECHANGEID = :modeChangeId,
            @MINIMUMRULEIDS = NULL`,
          {
            replacements: {
              userId: change.USERID,
              newMode: change.NEWMODE,
              previousMode: change.PREVIOUSMODE || 'STANDARD',
              reason: change.CHANGEREASON || 'RECONCILED',
              effectiveDate,
              modeChangeId: change.MODECHANGEID,
            },
            type: QueryTypes.SELECT,
          },
        );

        replayed += 1;
        console.log(
          `[ReconcileModeChanges] replayed change ${change.MODECHANGEID} ` +
            `(user ${change.USERID} -> ${change.NEWMODE} on ${effectiveDate})`,
        );
      } catch (rowError) {
        console.error(
          `[ReconcileModeChanges] failed to replay ${change.MODECHANGEID}:`,
          rowError.message,
        );
      }
    }

    await jobLogger.logSuccess(executionId, { replayed, found: undelivered.length });
    return { replayed, found: undelivered.length };
  } catch (error) {
    console.error('[ReconcileModeChanges] Error:', error.message);
    await jobLogger.logFailure(executionId, 'RECONCILE_FAILED', error.message);
    return { replayed: 0, error: error.message };
  }
}

if (ENABLED) {
  cron.schedule(CRON_EXPR, async () => {
    if (running) return;
    running = true;
    try {
      await reconcileOnce();
    } finally {
      running = false;
    }
  });
  console.log(`[ReconcileModeChanges] Job scheduled — ${CRON_EXPR}`);
} else {
  console.log('[ReconcileModeChanges] Disabled (MODE_CHANGE_RECONCILE_ENABLED=false)');
}

module.exports = { reconcileOnce };
