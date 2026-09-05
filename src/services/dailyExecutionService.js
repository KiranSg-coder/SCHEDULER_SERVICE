// src/services/dailyExecutionService.js
const axios = require('axios');

class DailyExecutionService {
  constructor() {
    this.baseURL = process.env.DAILY_EXECUTION_URL || "http://localhost:6004";
    this.serviceKey = process.env.INTERNAL_SERVICE_KEY;
  }

  async createDay(dayData) {
    const url = `${this.baseURL}/internal/day/create`;
    try {
      console.log(`[DailyExecution] POST ${url}`);
      const response = await axios.post(
        url,
        dayData,
        { headers: { 'X-Service-Key': this.serviceKey } }
      );
      console.log(`[DailyExecution] createDay response: ${response.status}`, JSON.stringify(response.data));
      return response.data.data;
    } catch (error) {
      console.error(`[DailyExecution] createDay failed: ${error.message}`);
      if (error.response) {
        console.error(`[DailyExecution] Status: ${error.response.status}, Body:`, JSON.stringify(error.response.data));
      }
      throw error;
    }
  }

  async closeDay(dayId, closedAt) {
    console.log(dayId,closedAt);
    
    try {
      const response = await axios.post(
        `${this.baseURL}/internal/day/close`,
        { dayId, closedAt },
        { headers: { 'X-Service-Key': this.serviceKey } }
      );
      return response.data.data;
    } catch (error) {
      console.error(`[DailyExecution] closeDay failed for dayId ${dayId}:`, error.message);
      throw error;
    }
  }

  async getTodayDay(userId) {
    try {
      const response = await axios.get(`${this.baseURL}/day/today`, {
        params: { userId },
        headers: { 'X-Service-Key': this.serviceKey },
      });
      const data = response.data?.data;
      // GET /day/today returns 200 + { day: null, reason: 'NO_DAY_TODAY' } when no USERDAY
      if (
        !data ||
        data.day === null ||
        data.reason === 'NO_DAY_TODAY'
      ) {
        return null;
      }
      return data;
    } catch (error) {
      console.error(`[DailyExecution] getTodayDay failed for user ${userId}:`, error.message);
      throw error;
    }
  }

  async getNudgeCandidates(utcTime) {
    const url = `${this.baseURL}/internal/day/nudge-candidates`;
    try {
      console.log(`[DailyExecution] GET ${url}?utcTime=${utcTime}`);
      const response = await axios.get(url, {
        params: { utcTime },
        headers: { 'X-Service-Key': this.serviceKey },
      });
      return response.data.data || [];
    } catch (error) {
      console.error(`[DailyExecution] getNudgeCandidates failed:`, error.message);
      return [];
    }
  }

  async getPreviousDayResult(userId, currentDayDate) {
    const url = `${this.baseURL}/internal/day/previous-result`;
    try {
      console.log(
        `[DailyExecution] POST ${url} body=`,
        JSON.stringify({ userId, currentDayDate }),
      );
      const response = await axios.post(
        url,
        { userId, currentDayDate },
        {
          headers: {
            'X-Service-Key': this.serviceKey,
            'Content-Type': 'application/json',
          },
        },
      );
      return response.data.data;
    } catch (error) {
      console.error(`[DailyExecution] getPreviousDayResult failed for user ${userId}:`, error.message);
      return null;
    }
  }

}

module.exports = new DailyExecutionService();