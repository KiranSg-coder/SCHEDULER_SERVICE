const axios = require("axios");

async function registerEventSubscriptions() {
  const EVENT_BUS_URL = (process.env.EVENT_BUS_URL || "http://localhost:6006").replace(/\/$/, "");
  const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY;
  const baseUrl = (process.env.SCHEDULER_SERVICE_URL || "http://localhost:6004").replace(/\/$/, "");
  const webhookUrl = `${baseUrl}/webhook/event`;

  const subs = [
    "MODE_CHANGED_TO_MINIMUM",
    "MODE_CHANGED_TO_STANDARD",
    "SUBSCRIPTION_CREATED",
    "SUBSCRIPTION_CANCELED",
    "PLAN_CHANGED",
    "PAYMENT_FAILED",
  ].map(eventType => ({
    eventType,
    subscriberName: "SCHEDULER_SERVICE",
    webhookUrl,
    serviceType: "INTERNAL",
    priority: 50,
    maxRetries: 3,
    timeoutMs: 5000,
  }));

  try {
    for (const sub of subs) {
      await axios.post(`${EVENT_BUS_URL}/subscription/register`, sub, {
        headers: {
          "Content-Type": "application/json",
          "X-Service-Key": SERVICE_KEY,
        },
        timeout: 5000,
      });
      console.log(`[Scheduler] ✅ Subscribed to ${sub.eventType}`);
    }
  } catch (err) {
    console.error("[Scheduler] ❌ Subscription failed:", err.message);
  }
}

module.exports = { registerEventSubscriptions };