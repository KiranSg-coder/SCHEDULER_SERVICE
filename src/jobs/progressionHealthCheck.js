// src/jobs/progressionHealthCheck.js
//
// Read-only detectors for the progression pipeline. Emits one structured log
// line per signal so an operator (or a log alert) can see a stalled user
// without opening the database.
//
// Signals:
//   STALLED_RULESET         active ruleset producing no days
//   BLOCKED_DRAFT           promotion waiting on the user (SETUPBLOCKING = 1)
//   STRANDED_USER           completed challenge, no active ruleset at all
//   UNDELIVERED_MODE_CHANGE decided in Discipline, missing in Scheduler
const cron = require('node-cron');
const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');
const jobLogger = require('../utils/joblogger');

const ENABLED = process.env.PROGRESSION_HEALTH_ENABLED !== 'false';
const CRON_EXPR = process.env.PROGRESSION_HEALTH_CRON || '20 * * * *';
const STALL_DAYS = Number(process.env.PROGRESSION_STALL_DAYS || 2);
const BLOCKED_DRAFT_ALERT_DAYS = Number(process.env.BLOCKED_DRAFT_ALERT_DAYS || 3);

let running = false;

function emit(signal, level, payload) {
  const line = JSON.stringify({
    component: 'progressionHealth',
    signal,
    level,
    ts: new Date().toISOString(),
    ...payload,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

async function runHealthCheck() {
  const executionId = await jobLogger.logStart('PROGRESSION_HEALTH');

  try {
    const raw = await sequelize.query(
      `EXEC USP_GET_PROGRESSION_HEALTH @STALLDAYS = :stallDays`,
      { replacements: { stallDays: STALL_DAYS }, type: QueryTypes.RAW },
    );

    const rows = raw[0] || [];
    const bySignal = (name) => rows.filter((r) => r.Signal === name);

    const stalled = bySignal('STALLED_RULESET');
    const blocked = bySignal('BLOCKED_DRAFT');
    const stranded = bySignal('STRANDED_USER');
    const undelivered = bySignal('UNDELIVERED_MODE_CHANGE');

    for (const r of stalled) {
      emit('STALLED_RULESET', 'error', {
        userId: r.USERID,
        rulesetId: r.RULESETID,
        challengeLevel: r.CHALLENGELEVEL,
        lastDayDate: r.LastDayDate,
        nextDayStartUtc: r.NEXTDAYSTARTUTC,
        message: 'Active ruleset is not producing days',
      });
    }

    for (const r of blocked) {
      const age = Number(r.AgeDays) || 0;
      emit('BLOCKED_DRAFT', age >= BLOCKED_DRAFT_ALERT_DAYS ? 'error' : 'warn', {
        userId: r.USERID,
        rulesetId: r.RULESETID,
        challengeLevel: r.CHALLENGELEVEL,
        ageDays: age,
        message: 'Promotion is blocked awaiting user setup',
      });
    }

    for (const r of stranded) {
      emit('STRANDED_USER', 'error', {
        userId: r.USERID,
        lastRulesetId: r.LastRulesetId,
        lastCompletedAt: r.LastCompletedAt,
        message: 'User has no active ruleset — promotion did not produce one',
      });
    }

    for (const r of undelivered) {
      emit('UNDELIVERED_MODE_CHANGE', 'warn', {
        userId: r.USERID,
        modeChangeId: r.MODECHANGEID,
        newMode: r.NEWMODE,
        effectiveDate: r.EFFECTIVEDATE,
        message: 'Mode change decided but never queued — reconciler should replay it',
      });
    }

    const summary = {
      stalledRulesets: stalled.length,
      blockedDrafts: blocked.length,
      strandedUsers: stranded.length,
      undeliveredModeChanges: undelivered.length,
    };

    emit('SUMMARY', summary.stalledRulesets || summary.strandedUsers ? 'warn' : 'info', summary);
    await jobLogger.logSuccess(executionId, summary);
    return summary;
  } catch (error) {
    console.error('[ProgressionHealth] Error:', error.message);
    await jobLogger.logFailure(executionId, 'HEALTH_CHECK_FAILED', error.message);
    return { error: error.message };
  }
}

if (ENABLED) {
  cron.schedule(CRON_EXPR, async () => {
    if (running) return;
    running = true;
    try {
      await runHealthCheck();
    } finally {
      running = false;
    }
  });
  console.log(`[ProgressionHealth] Job scheduled — ${CRON_EXPR}`);
} else {
  console.log('[ProgressionHealth] Disabled (PROGRESSION_HEALTH_ENABLED=false)');
}

module.exports = { runHealthCheck };
