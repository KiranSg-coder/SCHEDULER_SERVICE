// Polls TODO_SERVICE for due reminders, sends push via NOTIFICATION_SERVICE, then marks sent on TODO_TASK.
const cron = require("node-cron");
const todoService = require("../services/todoService");
const notificationService = require("../services/notificationService");
const jobLogger = require("../utils/joblogger");

const CRON_EXPR = process.env.TODO_REMINDERS_CRON || "* * * * *";
const BATCH_SIZE = parseInt(process.env.TODO_REMINDERS_BATCH_SIZE || "100", 10);

/**
 * Only mark REMINDERSENTAT when the user actually received something or explicitly disabled reminders.
 * Otherwise the scheduler would clear the reminder from the queue while nothing was delivered
 * (e.g. no FCM device, all pushes failed, or inbox log failed).
 */
function shouldMarkTodoReminderSent(notificationResult) {
  if (!notificationResult || notificationResult.success !== true) return false;
  if (notificationResult.skipped) {
    return notificationResult.skipCode === "PREF_DISABLED";
  }
  const sentTo = notificationResult.data?.sentTo ?? 0;
  return sentTo > 0;
}

cron.schedule(CRON_EXPR, async () => {
  const nowUtc = new Date().toISOString();

  if (process.env.TODO_REMINDERS_ENABLED === "0" || process.env.TODO_REMINDERS_ENABLED === "false") {
    return;
  }

  try {
    const tasks = await todoService.getDueReminders(nowUtc, BATCH_SIZE);
    if (!tasks.length) {
      return;
    }

    console.log(`[TodoReminder] Processing ${tasks.length} due reminder(s)`);

    for (const task of tasks) {
      const executionId = await jobLogger.logStart("TODO_REMINDER", task.userId, nowUtc.split("T")[0]);

      try {
        const notifResult = await notificationService.sendTodoReminder(task.userId, {
          taskId: task.taskId,
          listId: task.listId,
          title: task.title,
          listName: task.listName,
          dueAtUtc: task.dueAtUtc,
        });

        if (!shouldMarkTodoReminderSent(notifResult)) {
          await jobLogger.logFailure(executionId, "NOTIFICATION_FAILED", "Notification did not return success/skipped");
          continue;
        }

        const markResult = await todoService.markReminderSent(task.taskId, nowUtc);
        if (!markResult.updated) {
          console.warn(`[TodoReminder] markReminderSent updated 0 rows for taskId=${task.taskId} (race or already sent)`);
        }

        await jobLogger.logSuccess(executionId, {
          userId: task.userId,
          taskId: task.taskId,
          skipped: Boolean(notifResult.skipped),
        });
      } catch (err) {
        console.error(`[TodoReminder] Failed taskId=${task.taskId} userId=${task.userId}:`, err.message);
        await jobLogger.logFailure(executionId, "TODO_REMINDER_FAILED", err.message);
      }
    }
  } catch (error) {
    console.error("[TodoReminder] Job error:", error.message);
  }
});

console.log(`[TodoReminder] Job scheduled — cron="${CRON_EXPR}" batch=${BATCH_SIZE} (set TODO_REMINDERS_ENABLED=0 to disable)`);
