const cron = require("node-cron");
const { QueryTypes } = require("sequelize");
const sequelize = require("../config/database");
const notificationService = require("../services/notificationService");
const jobLogger = require("../utils/joblogger");

/**
 * Checks for trials ending within 24 hours (notification nudge only).
 * Runs once per hour at minute 15.
 * Queries SUBSCRIPTION_SERVICE database directly (cross-DB query).
 * This is not a payment-gateway job — no Stripe/charge logic. When you integrate billing,
 * add dunning or payment retry via Stripe webhooks or a dedicated job.
 */
cron.schedule("15 * * * *", async () => {
  const executionId = await jobLogger.logStart("CHECK_TRIAL_EXPIRY");

  try {
    console.log("[CheckSubscriptions] Checking for expiring trials...");

    let expiringTrials = [];
    try {
      expiringTrials = await sequelize.query(
        `SELECT US.USERID, US.TRIALEND, PM.PLANCODE, PM.DISPLAYNAME
         FROM [SUBSCRIPTION_SERVICE].[dbo].[USER_SUBSCRIPTION] US
         INNER JOIN [SUBSCRIPTION_SERVICE].[dbo].[PLAN_MASTER] PM ON PM.PLANID = US.PLANID
         WHERE US.[STATUS] = 'TRIALING'
           AND US.TRIALEND IS NOT NULL
           AND US.TRIALEND BETWEEN SYSUTCDATETIME() AND DATEADD(HOUR, 24, SYSUTCDATETIME())`,
        { type: QueryTypes.SELECT }
      );
    } catch (dbErr) {
      console.error("[CheckSubscriptions] Cross-DB query failed (SUBSCRIPTION_SERVICE may not be linked):", dbErr.message);
      await jobLogger.logFailure(executionId, "DB_ERROR", dbErr.message);
      return;
    }

    if (expiringTrials.length === 0) {
      await jobLogger.logSuccess(executionId, { checked: 0 });
      return;
    }

    console.log(`[CheckSubscriptions] ${expiringTrials.length} trial(s) expiring soon`);

    let notified = 0;
    let skipped = 0;
    for (const trial of expiringTrials) {
      try {
        const NOTIFICATION_URL = process.env.NOTIFICATION_URL || "http://localhost:6010";
        const { data: sendBody } = await require("axios").post(
          `${NOTIFICATION_URL}/internal/send`,
          {
            userId: trial.USERID,
            templateCode: "TRIAL_ENDING",
            data: {
              planName: trial.DISPLAYNAME || trial.PLANCODE,
              trialEnd: trial.TRIALEND,
              dateKey: new Date().toISOString().slice(0, 10),
            },
            priority: "HIGH",
          },
          { headers: { "X-Service-Key": process.env.INTERNAL_SERVICE_KEY }, timeout: 5000 }
        );
        // Notification service dedupes once/day via DEDUPEKEY — do not count repeats
        if (sendBody?.data?.skipCode === "DEDUPED") {
          skipped++;
        } else {
          notified++;
        }
      } catch (notifErr) {
        console.error(`[CheckSubscriptions] Notification failed for user ${trial.USERID}:`, notifErr.message);
      }
    }

    await jobLogger.logSuccess(executionId, {
      expiringTrials: expiringTrials.length,
      notified,
      skippedDeduped: skipped,
    });

    console.log(
      `[CheckSubscriptions] Done: ${notified} notified, ${skipped} deduped / ${expiringTrials.length}`,
    );
  } catch (error) {
    console.error("[CheckSubscriptions] Error:", error.message);
    await jobLogger.logFailure(executionId, "CHECK_FAILED", error.message);
  }
});

console.log("[CheckSubscriptions] Job scheduled — runs hourly at :15");
