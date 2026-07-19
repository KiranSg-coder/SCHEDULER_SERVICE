const axios = require("axios");

class SubscriptionService {
  constructor() {
    this.baseURL = (process.env.SUBSCRIPTION_SERVICE_URL || "http://localhost:6009").replace(/\/$/, "");
    this.serviceKey = process.env.INTERNAL_SERVICE_KEY;
  }

  async getSubscriptionSummary(userId) {
    const url = `${this.baseURL}/internal/users/${userId}/summary`;
    try {
      const response = await axios.get(url, {
        headers: { "X-Service-Key": this.serviceKey },
        timeout: 5000,
      });
      return response.data?.data || null;
    } catch (error) {
      console.error(`[Scheduler→Subscription] getSummary user ${userId}:`, error.message);
      return null;
    }
  }
}

module.exports = new SubscriptionService();
