const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');

class JobLogger {
  async logStart(jobType, userId = null, targetDate = null) {
    try {
      const result = await sequelize.query(
        `EXEC USP_LOG_JOB_START 
          @JOBTYPE = :jobType,
          @USERID = :userId,
          @TARGETDATE = :targetDate`,
        {
          replacements: { jobType, userId, targetDate },
          type: QueryTypes.SELECT,
        }
      );
      return result[0]?.ExecutionId;
    } catch (error) {
      console.error('[JobLogger] Failed to log start:', error.message);
      return null;
    }
  }

  async logSuccess(executionId, metadata = null) {
    try {
      await sequelize.query(
        `EXEC USP_LOG_JOB_SUCCESS 
          @EXECUTIONID = :executionId,
          @METADATA = :metadata`,
        {
          replacements: {
            executionId,
            metadata: metadata ? JSON.stringify(metadata) : null,
          },
          type: QueryTypes.UPDATE,
        }
      );
    } catch (error) {
      console.error('[JobLogger] Failed to log success:', error.message);
    }
  }

  async logFailure(executionId, errorCode, errorMessage) {
    try {
      await sequelize.query(
        `EXEC USP_LOG_JOB_FAILURE 
          @EXECUTIONID = :executionId,
          @ERRORCODE = :errorCode,
          @ERRORMESSAGE = :errorMessage`,
        {
          replacements: { executionId, errorCode, errorMessage },
          type: QueryTypes.UPDATE,
        }
      );
    } catch (error) {
      console.error('[JobLogger] Failed to log failure:', error.message);
    }
  }
}

module.exports = new JobLogger();