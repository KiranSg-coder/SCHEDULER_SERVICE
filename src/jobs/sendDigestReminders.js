/**
 * Morning briefing (08:00-ish local via hourly scan) and weekly Sunday summary.
 * Also sends retention review nudges when REVIEW_SERVICE is reachable.
 *
 * Env:
 *   DIGEST_REMINDERS_ENABLED=0 to disable
 *   MORNING_BRIEFING_LOCAL_HOUR=8
 *   WEEKLY_SUMMARY_LOCAL_HOUR=18 (Sunday)
 */
const cron = require('node-cron');
const axios = require('axios');
const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');
const jobLogger = require('../utils/joblogger');

const ENABLED = !['0', 'false', 'FALSE'].includes(String(process.env.DIGEST_REMINDERS_ENABLED || '1'));
const NOTIFICATION_URL = (process.env.NOTIFICATION_URL || 'http://localhost:6010').replace(/\/$/, '');
const REVIEW_URL = (process.env.REVIEW_SERVICE_URL || process.env.REVIEW_URL || 'http://localhost:6003').replace(/\/$/, '');
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY;
const MORNING_HOUR = Number(process.env.MORNING_BRIEFING_LOCAL_HOUR || 8);
const WEEKLY_HOUR = Number(process.env.WEEKLY_SUMMARY_LOCAL_HOUR || 18);

async function sendTemplate(userId, templateCode, data) {
  const { data: body } = await axios.post(
    `${NOTIFICATION_URL}/internal/send`,
    { userId, templateCode, data, priority: 'MEDIUM' },
    {
      headers: { 'X-Service-Key': SERVICE_KEY },
      timeout: 8000,
    },
  );
  return body;
}

function localHourInTz(timeZone, now = new Date()) {
  try {
    const iana =
      timeZone === 'India Standard Time' ? 'Asia/Kolkata' : timeZone || 'UTC';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: iana.includes('/') ? iana : 'UTC',
      weekday: 'short',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? -1);
    const weekday = parts.find((p) => p.type === 'weekday')?.value || '';
    return { hour, weekday };
  } catch {
    return { hour: now.getUTCHours(), weekday: '' };
  }
}

cron.schedule('5 * * * *', async () => {
  if (!ENABLED) return;
  const executionId = await jobLogger.logStart('DIGEST_REMINDERS');
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);

  try {
    let prefs = [];
    try {
      prefs = await sequelize.query(
        `SELECT DISTINCT USERID, MAX(TIMEZONE) AS TIMEZONE
         FROM [NOTIFICATION_SERVICE].[dbo].[USER_NOTIFICATION_PREFERENCE]
         GROUP BY USERID`,
        { type: QueryTypes.SELECT },
      );
    } catch (e) {
      console.warn('[DigestReminders] preference query failed:', e.message);
      await jobLogger.logFailure(executionId, 'DB_ERROR', e.message);
      return;
    }

    let morning = 0;
    let weekly = 0;
    let reviews = 0;

    for (const row of prefs) {
      const userId = row.USERID;
      const tz = row.TIMEZONE || 'India Standard Time';
      const { hour, weekday } = localHourInTz(tz, now);

      if (hour === MORNING_HOUR) {
        try {
          const body = await sendTemplate(userId, 'MORNING_BRIEFING', {
            dateKey,
            openCommitments: 'your',
            todoSuffix: '',
          });
          if (body?.data?.skipCode !== 'DEDUPED') morning++;
        } catch (err) {
          /* ignore per-user */
        }
      }

      if (weekday === 'Sun' && hour === WEEKLY_HOUR) {
        try {
          const weekKey = `${dateKey.slice(0, 4)}-W${Math.ceil(now.getUTCDate() / 7)}`;
          const body = await sendTemplate(userId, 'WEEKLY_SUMMARY', {
            weekKey,
            passedDays: '—',
            totalDays: '7',
            streakDays: '—',
          });
          if (body?.data?.skipCode !== 'DEDUPED') weekly++;
        } catch (err) {
          /* ignore */
        }
      }
    }

    // Retention review due (best-effort; REVIEW_SERVICE may expose different path)
    try {
      const { data } = await axios.get(`${REVIEW_URL}/internal/retention/due-summary`, {
        headers: { 'X-Service-Key': SERVICE_KEY },
        timeout: 5000,
        validateStatus: () => true,
      });
      const dueList = data?.data?.users || data?.users || [];
      for (const u of dueList) {
        const userId = u.userId ?? u.USERID;
        const cardCount = u.cardCount ?? u.count ?? 1;
        if (!userId) continue;
        try {
          const body = await sendTemplate(userId, 'RETENTION_REVIEW_DUE', {
            dateKey,
            cardCount,
          });
          if (body?.data?.skipCode !== 'DEDUPED') reviews++;
        } catch {
          /* ignore */
        }
      }
    } catch (reviewErr) {
      console.warn('[DigestReminders] review due skipped:', reviewErr.message);
    }

    await jobLogger.logSuccess(executionId, { morning, weekly, reviews, users: prefs.length });
    console.log(`[DigestReminders] morning=${morning} weekly=${weekly} reviews=${reviews}`);
  } catch (error) {
    console.error('[DigestReminders]', error.message);
    await jobLogger.logFailure(executionId, 'DIGEST_FAILED', error.message);
  }
});

if (ENABLED) {
  console.log('[DigestReminders] Job scheduled — hourly at :05');
} else {
  console.log('[DigestReminders] Disabled');
}
