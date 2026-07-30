// Polls TODO_SERVICE for due reminders, sends push via NOTIFICATION_SERVICE, then marks sent on TODO_TASK.
const cron = require("node-cron");
const todoService = require("../services/todoService");
const notificationService = require("../services/notificationService");
const jobLogger = require("../utils/joblogger");

const CRON_EXPR = process.env.TODO_REMINDERS_CRON || "* * * * *";
const BATCH_SIZE = parseInt(process.env.TODO_REMINDERS_BATCH_SIZE || "100", 10);

/**
 * Mark REMINDERSENTAT when delivery is durable enough that retrying would spam.
 * Quiet hours: do NOT mark — wait until outside quiet window.
 */
function shouldMarkTodoReminderSent(notificationResult) {
  if (!notificationResult || notificationResult.success !== true) return false;
  if (notificationResult.skipped) {
    return (
      notificationResult.skipCode === "PREF_DISABLED" ||
      notificationResult.skipCode === "EXPIRED_REMINDER"
    );
  }
  const mode = notificationResult.data?.deliveryMode;
  if (mode === "IN_APP_QUIET_HOURS") return false;
  if (mode === "IN_APP_ONLY" || mode === "IN_APP_PUSH_FAILED" || mode === "PUSH_AND_IN_APP") {
    return true;
  }
  const sentTo = notificationResult.data?.sentTo ?? 0;
  return sentTo > 0;
}

function logReminder(stage, fields) {
  console.log(
    JSON.stringify({
      component: "todoReminderJob",
      stage,
      ts: new Date().toISOString(),
      ...fields,
    }),
  );
}

cron.schedule(CRON_EXPR, async () => {
  const nowUtc = new Date().toISOString();

  if (process.env.TODO_REMINDERS_ENABLED === "0" || process.env.TODO_REMINDERS_ENABLED === "false") {
    return;
  }

  try {
    const { tasks, expiredTasks } = await todoService.getDueReminders(nowUtc, BATCH_SIZE);

    // Stale reminders (older than lookback): mark sent without notifying — never send yesterday's catch-up.
    for (const task of expiredTasks || []) {
      try {
        await todoService.markReminderSent(task.taskId, nowUtc);
        logReminder("reminder_expired_skipped", {
          taskId: task.taskId,
          userId: task.userId,
          reminderAtUtc: task.reminderAtUtc,
          reason: "outside_lookback_window",
        });
      } catch (err) {
        logReminder("reminder_expired_mark_failed", {
          taskId: task.taskId,
          error: err.message,
        });
      }
    }

    if (!tasks.length) {
      return;
    }

    logReminder("batch_start", { count: tasks.length, nowUtc });

    for (const task of tasks) {
      const executionId = await jobLogger.logStart("TODO_REMINDER", task.userId, nowUtc.split("T")[0]);

      try {
        const title = (task.title && String(task.title).trim()) || "Task";
        const listName = (task.listName && String(task.listName).trim()) || "";

        // Never notify without a concrete task title (would produce empty/broken UX).
        if (!title || title === "{{title}}") {
          logReminder("reminder_skipped_invalid_title", { taskId: task.taskId, userId: task.userId });
          await todoService.markReminderSent(task.taskId, nowUtc);
          await jobLogger.logFailure(executionId, "INVALID_TITLE", "Missing task title");
          continue;
        }

        // Guard: only fire if reminder time is due (API should already filter).
        if (task.reminderAtUtc && new Date(task.reminderAtUtc).getTime() > Date.now() + 5000) {
          logReminder("reminder_skipped_not_due", {
            taskId: task.taskId,
            reminderAtUtc: task.reminderAtUtc,
          });
          await jobLogger.logFailure(executionId, "NOT_DUE", "Reminder not due yet");
          continue;
        }

        const notifResult = await notificationService.sendTodoReminder(task.userId, {
          taskId: task.taskId,
          listId: task.listId,
          title,
          listName,
          dueAtUtc: task.dueAtUtc,
        });

        logReminder("reminder_send_result", {
          taskId: task.taskId,
          userId: task.userId,
          deliveryMode: notifResult?.data?.deliveryMode || null,
          skipCode: notifResult?.skipCode || null,
          sentTo: notifResult?.data?.sentTo ?? null,
        });

        if (!shouldMarkTodoReminderSent(notifResult)) {
          await jobLogger.logFailure(
            executionId,
            "NOTIFICATION_PENDING",
            notifResult?.data?.deliveryMode || "waiting_for_delivery",
          );
          continue;
        }

        const markResult = await todoService.markReminderSent(task.taskId, nowUtc);
        if (!markResult.updated) {
          console.warn(
            `[TodoReminder] markReminderSent updated 0 rows for taskId=${task.taskId} (race or already sent)`,
          );
        }

        await jobLogger.logSuccess(executionId, {
          userId: task.userId,
          taskId: task.taskId,
          skipped: Boolean(notifResult.skipped),
          deliveryMode: notifResult?.data?.deliveryMode,
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

console.log(
  `[TodoReminder] Job scheduled — cron="${CRON_EXPR}" batch=${BATCH_SIZE} (set TODO_REMINDERS_ENABLED=0 to disable)`,
);
