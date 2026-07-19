// scheduler-service/services/notificationService.js
const axios = require('axios');

class NotificationService {
  constructor() {
    this.baseURL = process.env.NOTIFICATION_URL || 'http://localhost:6005';
    this.serviceKey = process.env.INTERNAL_SERVICE_KEY;
  }

  /**
   * Send day start notification
   */
  async sendDayStartNotification(userId, dayNumber, mode, minimumModeReason = null) {
    const url = `${this.baseURL}/internal/send`;
    const templateCode = mode === 'MINIMUM' ? 'DAY_START_MINIMUM' : 'DAY_START_STANDARD';
    try {
      const data = {
        dayNumber,
        totalRules: mode === 'MINIMUM' ? 2 : 4,
      };
      if (minimumModeReason) {
        data.reason = minimumModeReason;
      }

      console.log(
        `[Scheduler→Notification][DAY_START] template=${templateCode} userId=${userId} NOTIFICATIONTYPE path=day-start`,
        JSON.stringify(data),
      );
      const response = await axios.post(
        url,
        { userId, templateCode, data, priority: 'HIGH' },
        { headers: { 'X-Service-Key': this.serviceKey } }
      );
      console.log(`[Notification] ✓ ${templateCode} sent to user ${userId}`);
      return response.data;
    } catch (error) {
      console.error(`[Notification] Failed ${templateCode} for user ${userId}:`, error.message);
      if (error.response) {
        console.error(`[Notification] Status: ${error.response.status}, Body:`, JSON.stringify(error.response.data));
      }
      throw error;
    }
  }

  /**
   * Send day end reminder (30 min before)
   */
  async sendDayEndReminder(userId, remainingRules) {
    const url = `${this.baseURL}/internal/send`;
    const templateCode = 'DAY_END_REMINDER';
    try {
      console.log(
        `[Scheduler→Notification][DAY_END_REMINDER] userId=${userId}`,
        JSON.stringify({ remainingRules }),
      );
      const response = await axios.post(
        url,
        {
          userId,
          templateCode,
          data: { remainingRules },
          priority: 'HIGH'
        },
        { headers: { 'X-Service-Key': this.serviceKey } }
      );
      console.log(`[Notification] ✓ ${templateCode} sent to user ${userId}`);
      return response.data;
    } catch (error) {
      console.error(`[Notification] Failed ${templateCode} for user ${userId}:`, error.message);
      if (error.response) {
        console.error(`[Notification] Status: ${error.response.status}, Body:`, JSON.stringify(error.response.data));
      }
    }
  }

  /**
   * Send day closed notification
   */
  async sendDayClosedNotification(userId, dayNumber, completedRules, totalRules) {
    const url = `${this.baseURL}/internal/send`;
    const templateCode = 'DAY_END_CLOSED';
    try {
      console.log(
        `[Scheduler→Notification][DAY_END_CLOSED] userId=${userId}`,
        JSON.stringify({ dayNumber, completedRules, totalRules }),
      );
      const response = await axios.post(
        url,
        {
          userId,
          templateCode,
          data: { dayNumber, completedRules, totalRules },
          priority: 'MEDIUM'
        },
        { headers: { 'X-Service-Key': this.serviceKey } }
      );
      console.log(`[Notification] ✓ ${templateCode} sent to user ${userId}`);
      return response.data;
    } catch (error) {
      console.error(`[Notification] Failed ${templateCode} for user ${userId}:`, error.message);
      if (error.response) {
        console.error(`[Notification] Status: ${error.response.status}, Body:`, JSON.stringify(error.response.data));
      }
    }
  }

  /**
   * Send evening nudge (30 min before day end, incomplete items remain)
   */
  async sendEveningNudge(userId, remainingRules, dayNumber) {
    const url = `${this.baseURL}/internal/send`;
    const templateCode = 'DAY_END_NUDGE';
    try {
      console.log(
        `[Scheduler→Notification][EVENING_NUDGE/REMINDER] userId=${userId}`,
        JSON.stringify({ remainingRules, dayNumber }),
      );
      const response = await axios.post(
        url,
        {
          userId,
          templateCode,
          data: { remainingRules, dayNumber },
          priority: 'HIGH'
        },
        { headers: { 'X-Service-Key': this.serviceKey } }
      );
      console.log(`[Notification] ${templateCode} sent to user ${userId}`);
      return response.data;
    } catch (error) {
      console.error(`[Notification] Failed ${templateCode} for user ${userId}:`, error.message);
      if (error.response) {
        console.error(`[Notification] Status: ${error.response.status}, Body:`, JSON.stringify(error.response.data));
      }
    }
  }

  /**
   * Send previous-day-incomplete acknowledgment at day start
   */
  async sendPreviousDayIncompleteNotification(userId, previousDayNumber, completedRules, totalRules) {
    const url = `${this.baseURL}/internal/send`;
    const templateCode = 'PREVIOUS_DAY_INCOMPLETE';
    try {
      const reminderPayload = {
        previousDayNumber,
        completedRules,
        totalRules,
      };
      console.log(
        `[Scheduler→Notification][PREVIOUS_DAY_INCOMPLETE/REMINDER] userId=${userId}`,
        JSON.stringify(reminderPayload),
      );
      const response = await axios.post(
        url,
        {
          userId,
          templateCode,
          data: reminderPayload,
          priority: 'MEDIUM'
        },
        { headers: { 'X-Service-Key': this.serviceKey } }
      );
      console.log(`[Notification] ${templateCode} sent to user ${userId}`);
      return response.data;
    } catch (error) {
      console.error(`[Notification] Failed ${templateCode} for user ${userId}:`, error.message);
      if (error.response) {
        console.error(`[Notification] Status: ${error.response.status}, Body:`, JSON.stringify(error.response.data));
      }
    }
  }

  /**
   * Initialize user preferences (called when user registers)
   */
  /**
   * To-do reminder (custom lists; independent of streak rules).
   * Requires NOTIFICATION_TEMPLATE row TEMPLATECODE = 'TODO_REMINDER' (see NOTIFICATION_SERVICE/sql).
   */
  async sendTodoReminder(userId, { taskId, listId, title, listName, dueAtUtc }) {
    const url = `${this.baseURL}/internal/send`;
    const templateCode = "TODO_REMINDER";
    try {
      const data = {
        title: title || "Task",
        listName: listName || "",
        taskId,
        listId: listId != null ? listId : undefined,
        dueAt: dueAtUtc ? new Date(dueAtUtc).toISOString() : "",
      };
      console.log(`[Scheduler→Notification][TODO_REMINDER] userId=${userId}`, JSON.stringify(data));
      const response = await axios.post(
        url,
        { userId, templateCode, data, priority: "HIGH" },
        { headers: { "X-Service-Key": this.serviceKey } }
      );
      console.log(`[Notification] ✓ ${templateCode} for user ${userId} taskId=${taskId}`);
      return response.data;
    } catch (error) {
      console.error(`[Notification] Failed ${templateCode} user ${userId} task ${taskId}:`, error.message);
      if (error.response) {
        console.error(`[Notification] Status: ${error.response.status}, Body:`, JSON.stringify(error.response.data));
      }
      throw error;
    }
  }

  async initializeUserPreferences(userId, timezone) {
    const url = `${this.baseURL}/internal/initialize-user`;
    try {
      console.log(`[Notification] Initializing preferences for user ${userId} (timezone: ${timezone})`);
      const response = await axios.post(
        url,
        { userId, timezone },
        { headers: { 'X-Service-Key': this.serviceKey } }
      );
      console.log(`[Notification] ✓ User ${userId} preferences initialized`);
      return response.data;
    } catch (error) {
      console.error(`[Notification] Failed to initialize user ${userId} preferences:`, error.message);
      if (error.response) {
        console.error(`[Notification] Status: ${error.response.status}, Body:`, JSON.stringify(error.response.data));
      }
      throw error;
    }
  }
}

module.exports = new NotificationService();