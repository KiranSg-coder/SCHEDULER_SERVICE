// src/services/ruleEngineService.js
const axios = require('axios');

class RuleEngineService {
  constructor() {
    this.baseURL = process.env.RULE_ENGINE_URL;
    this.serviceKey = process.env.INTERNAL_SERVICE_KEY;
  }

  async evaluateDay(dayId, userId) {
    try {
      const response = await axios.post(
        `${this.baseURL}/internal/evaluate`,
        {
          dayId,
          userId,
          triggeredBy: 'SCHEDULER',
          triggeredAt: new Date().toISOString(),
        },
        { headers: { 'X-Service-Key': this.serviceKey } }
      );
      return response.data.data;
    } catch (error) {
      console.error(`[RuleEngine] evaluateDay failed for dayId ${dayId}:`, error.message);
      throw error;
    }
  }
}

module.exports = new RuleEngineService();