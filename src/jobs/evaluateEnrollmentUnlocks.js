const cron = require("node-cron");
const axios = require("axios");
const jobLogger = require("../utils/joblogger");

const ENROLLMENT_URL =
  process.env.ENROLLMENT_SERVICE_URL ||
  process.env.ENROLLMENT_URL ||
  "http://localhost:6006";
const NOTIFICATION_URL =
  process.env.NOTIFICATION_URL || "http://localhost:6010";
const INTERNAL_KEY = process.env.INTERNAL_SERVICE_KEY;

/**
 * Evaluate calendar unlocks for Daily Guided / Weekly / Scheduled enrollments.
 * Runs every 15 minutes.
 */
cron.schedule("*/15 * * * *", async () => {
  const executionId = await jobLogger.logStart("EVALUATE_ENROLLMENT_UNLOCKS");

  try {
    if (
      process.env.ENROLLMENT_CALENDAR_UNLOCK != null &&
      ["0", "false", "no", "off"].includes(
        String(process.env.ENROLLMENT_CALENDAR_UNLOCK).trim().toLowerCase()
      )
    ) {
      await jobLogger.logSuccess(executionId, {
        skipped: true,
        reason: "flag_off",
      });
      return;
    }

    const resp = await axios.post(
      `${ENROLLMENT_URL}/internal/evaluate-unlocks`,
      { limit: 500 },
      {
        headers: INTERNAL_KEY ? { "X-Service-Key": INTERNAL_KEY } : {},
        timeout: 30000,
      }
    );

    const unlocked = resp.data?.data?.unlocked || [];
    let notified = 0;

    for (const u of unlocked) {
      try {
        await axios.post(
          `${NOTIFICATION_URL}/internal/send`,
          {
            userId: u.userId,
            templateCode: "ENROLLMENT_MISSION_UNLOCKED",
            data: {
              dayNumber: u.availableMissionDay,
              enrollmentId: u.enrollmentId,
            },
            priority: "NORMAL",
          },
          {
            headers: INTERNAL_KEY ? { "X-Service-Key": INTERNAL_KEY } : {},
            timeout: 5000,
          }
        );
        notified += 1;
      } catch (notifErr) {
        console.warn(
          "[EvaluateEnrollmentUnlocks] notify:",
          notifErr.response?.data?.message || notifErr.message
        );
      }
    }

    console.log(
      `[EvaluateEnrollmentUnlocks] unlocked=${unlocked.length} notified=${notified}`
    );
    await jobLogger.logSuccess(executionId, {
      unlocked: unlocked.length,
      notified,
    });
  } catch (err) {
    console.error("[EvaluateEnrollmentUnlocks]", err.message);
    await jobLogger.logFailure(executionId, "JOB_ERROR", err.message);
  }
});
