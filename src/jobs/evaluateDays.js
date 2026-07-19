// src/jobs/evaluateDays.js
const cron = require('node-cron');
const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');
const ruleEngineService = require('../services/ruleEngineService');
const jobLogger = require('../utils/joblogger');

// Run every minute
cron.schedule('* * * * *', async () => {
  try {
    console.log('[EvaluateDays] Checking for days to evaluate...');
    
    //=================================================
    // Find days that are PENDING evaluation
    //=================================================
    const pendingEvaluations = await sequelize.query(
      `SELECT QUEUEID, DAYID, USERID, DAYDATE
       FROM EVALUATION_QUEUE
       WHERE EVALUATIONSTATUS = 'PENDING'
         AND EVALUATIONATTEMPTS < 3
       ORDER BY CLOSEDAT ASC`,
      {
        type: QueryTypes.SELECT
      }
    );
    
    if (pendingEvaluations.length === 0) {
      return; // Nothing to evaluate
    }
    
    console.log(`[EvaluateDays] Found ${pendingEvaluations.length} days to evaluate`);
    
    // Process each day
    for (const evaluation of pendingEvaluations) {
      await evaluateDay(evaluation);
    }
    
  } catch (error) {
    console.error('[EvaluateDays] Error:', error.message);
  }
});

async function evaluateDay(evaluation) {
  // 🔴 FIX: Use UPPERCASE column names (SQL Server returns uppercase)
  const queueId = evaluation.QUEUEID;
  const dayId = evaluation.DAYID;
  const userId = evaluation.USERID;
  const dayDate = evaluation.DAYDATE;
  
  const executionId = await jobLogger.logStart('EVALUATE_DAY', userId, dayDate);
  
  try {
    console.log(`[EvaluateDays] Evaluating day ${dayId} for user ${userId}`);
    
    // Mark as evaluating
    await sequelize.query(
      `UPDATE EVALUATION_QUEUE
       SET EVALUATIONSTATUS = 'EVALUATING',
           LASTATTEMPT = SYSUTCDATETIME(),
           EVALUATIONATTEMPTS = EVALUATIONATTEMPTS + 1
       WHERE QUEUEID = :queueId`,
      {
        replacements: { queueId },
        type: QueryTypes.UPDATE
      }
    );
    
    //=================================================
    // 🔴 CALL RULE ENGINE
    //=================================================
    const evaluationResult = await ruleEngineService.evaluateDay(dayId, userId);
    
    // Mark as completed
    await sequelize.query(
      `UPDATE EVALUATION_QUEUE
       SET EVALUATIONSTATUS = 'COMPLETED',
           EVALUATEDAT = SYSUTCDATETIME(),
           EVALUATIONID = :evaluationId
       WHERE QUEUEID = :queueId`,
      {
        replacements: { 
          queueId, 
          evaluationId: evaluationResult.evaluationId 
        },
        type: QueryTypes.UPDATE
      }
    );
    
    console.log(`[EvaluateDays] ✓ Day ${dayId} evaluated: ${evaluationResult.result}`);
    
    // Check for mode changes
    if (evaluationResult.actions.minimumModeTriggered) {
      console.log(`[EvaluateDays] ⚠️ Minimum mode triggered for user ${userId}`);
    }
    
    if (evaluationResult.actions.recoveryModeTriggered) {
      console.log(`[EvaluateDays] ✅ Recovery mode triggered for user ${userId}`);
    }
    
    // Log success
    await jobLogger.logSuccess(executionId, {
      dayId,
      evaluationId: evaluationResult.evaluationId,
      result: evaluationResult.result
    });
    
  } catch (error) {
    console.error(`[EvaluateDays] Failed to evaluate day ${dayId}:`, error.message);
    console.error('[EvaluateDays] Error:', error);
    
    // Get attempt count
    const queueData = await sequelize.query(
      `SELECT EVALUATIONATTEMPTS FROM EVALUATION_QUEUE WHERE QUEUEID = :queueId`,
      {
        replacements: { queueId },
        type: QueryTypes.SELECT
      }
    );
    
    const attempts = queueData[0]?.EVALUATIONATTEMPTS || 0;
    
    if (attempts >= 3) {
      // Max retries reached
      await sequelize.query(
        `UPDATE EVALUATION_QUEUE SET EVALUATIONSTATUS = 'FAILED' WHERE QUEUEID = :queueId`,
        {
          replacements: { queueId },
          type: QueryTypes.UPDATE
        }
      );
      
      console.error(`[EvaluateDays] ❌ Day ${dayId} evaluation failed after 3 attempts`);
      
      await jobLogger.logFailure(executionId, 'MAX_RETRIES_EXCEEDED', error.message);
    } else {
      // Retry next minute
      await sequelize.query(
        `UPDATE EVALUATION_QUEUE SET EVALUATIONSTATUS = 'PENDING' WHERE QUEUEID = :queueId`,
        {
          replacements: { queueId },
          type: QueryTypes.UPDATE
        }
      );
      
      console.log(`[EvaluateDays] Day ${dayId} queued for retry (attempt ${attempts}/3)`);
      
      await jobLogger.logFailure(executionId, 'EVALUATION_FAILED', `${error.message} - will retry`);
    }
  }
}

console.log('[EvaluateDays] Job started - running every minute');

module.exports = { evaluateDay };