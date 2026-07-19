const axios = require("axios");

class TodoService {
  constructor() {
    this.baseURL = (process.env.TODO_SERVICE_URL || "http://localhost:6008").replace(/\/$/, "");
    this.serviceKey = process.env.INTERNAL_SERVICE_KEY;
  }

  /**
   * Tasks with reminderAtUtc <= nowUtc, OPEN, reminder not yet sent.
   */
  async getDueReminders(nowUtc, topN = 100) {
    const url = `${this.baseURL}/internal/todos/reminders/due`;
    try {
      const response = await axios.get(url, {
        params: { nowUtc, topN },
        headers: { "X-Service-Key": this.serviceKey },
        timeout: 15000,
      });
      return response.data?.data?.tasks || [];
    } catch (error) {
      console.error("[Scheduler→TODO] getDueReminders failed:", error.message);
      if (error.response) {
        console.error("[Scheduler→TODO] Status:", error.response.status, JSON.stringify(error.response.data));
      }
      throw error;
    }
  }

  /**
   * Idempotent mark reminder sent (REMINDERSENTAT) on TODO_TASK.
   */
  async markReminderSent(taskId, sentAtUtc) {
    const url = `${this.baseURL}/internal/todos/reminders/${taskId}/sent`;
    try {
      const response = await axios.post(
        url,
        { sentAtUtc },
        { headers: { "X-Service-Key": this.serviceKey, "Content-Type": "application/json" }, timeout: 10000 }
      );
      return response.data?.data || { taskId, updated: 0 };
    } catch (error) {
      console.error(`[Scheduler→TODO] markReminderSent taskId=${taskId}:`, error.message);
      if (error.response) {
        console.error("[Scheduler→TODO] Status:", error.response.status, JSON.stringify(error.response.data));
      }
      throw error;
    }
  }
}

module.exports = new TodoService();
