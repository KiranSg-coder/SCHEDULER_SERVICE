const axios = require('axios');

class RuleManagementService {
  constructor() {
    this.baseURL = process.env.RULE_MANAGEMENT_URL || "http://localhost:6012";
    this.serviceKey = process.env.INTERNAL_SERVICE_KEY;
  }

  async getUsersDayStart(utcTime) {
    const url = `${this.baseURL}/internal/ruleset/users-day-start`;
    try {
      console.log(`[RuleManagement] GET ${url} ?utcTime=${utcTime}`);
      const response = await axios.get(url, {
        params: { utcTime },
        headers: { 'X-Service-Key': this.serviceKey },
      });
      console.log(`[RuleManagement] getUsersDayStart response: ${response.status}, users: ${response.data.data?.users?.length || 0}`);
      return response.data.data.users || [];
    } catch (error) {
      console.error(`[RuleManagement] getUsersDayStart failed: ${error.message}`);
      if (error.response) {
        console.error(`[RuleManagement] Status: ${error.response.status}, Body:`, JSON.stringify(error.response.data));
      }
      throw error;
    }
  }

  async getUsersDayEnd(utcTime) {
    try {
      const response = await axios.get(`${this.baseURL}/internal/ruleset/users-day-end`, {
        params: { utcTime },
        headers: { 'X-Service-Key': this.serviceKey },
      });
      return response.data.data.users || [];
    } catch (error) {
      console.error('[RuleManagement] getUsersDayEnd failed:', error.message);
      throw error;
    }
  }

  async getActiveRuleset(userId) {
    const url = `${this.baseURL}/ruleset/active`;
    try {
      console.log(`[RuleManagement] GET ${url} ?userId=${userId}`);
      const response = await axios.get(url, {
        params: { userId },
        headers: { 'X-Service-Key': this.serviceKey },
      });
      console.log(`[RuleManagement] getActiveRuleset response: ${response.status}, ruleSetId=${response.data.data?.ruleSetId}`);
      return response.data.data;
    } catch (error) {
      console.error(`[RuleManagement] getActiveRuleset failed for user ${userId}: ${error.message}`);
      if (error.response) {
        console.error(`[RuleManagement] Status: ${error.response.status}, Body:`, JSON.stringify(error.response.data));
      }
      throw error;
    }
  }

  async activatePendingRulesets() {
    try {
      const response = await axios.post(
        `${this.baseURL}/internal/ruleset/activate-pending`,
        {},
        { headers: { 'X-Service-Key': this.serviceKey } }
      );
      return response.data.data;
    } catch (error) {
      console.error('[RuleManagement] activatePendingRulesets failed:', error.message);
      throw error;
    }
  }

  async completeExpiredRulesets() {
    try {
      const response = await axios.post(
        `${this.baseURL}/internal/ruleset/complete-expired`,
        {},
        { headers: { 'X-Service-Key': this.serviceKey } }
      );
      return response.data.data || { totalCompleted: 0, completedChallenges: [] };
    } catch (error) {
      console.error('[RuleManagement] completeExpiredRulesets failed:', error.message);
      throw error;
    }
  }
}

module.exports = new RuleManagementService();