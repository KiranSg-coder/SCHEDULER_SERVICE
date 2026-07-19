// src/controllers/monitoring.controller.js
const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');

const getHealthStatus = async (req, res) => {
  try {
    await sequelize.authenticate();
    
    return res.status(200).json({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: error.message,
    });
  }
};

const getJobHistory = async (req, res) => {
  try {
    const { limit = 50, jobType } = req.query;
    
    let query = `
      SELECT TOP ${parseInt(limit)}
        EXECUTIONID, JOBTYPE, USERID, TARGETDATE, STATUS,
        STARTEDAT, COMPLETEDAT, DURATIONMS, ERRORCODE, ERRORMESSAGE
      FROM JOB_EXECUTION_LOG
    `;
    
    if (jobType) {
      query += ` WHERE JOBTYPE = :jobType`;
    }
    
    query += ` ORDER BY STARTEDAT DESC`;
    
    const history = await sequelize.query(query, {
      replacements: { jobType },
      type: QueryTypes.SELECT,
    });

    return res.status(200).json({
      success: true,
      data: {
        total: history.length,
        jobs: history,
      },
    });
  } catch (error) {
    console.error('[Monitoring] getJobHistory error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

const getPendingModeChanges = async (req, res) => {
  try {
    const pendingChanges = await sequelize.query(
      `SELECT * FROM PENDING_MODE_CHANGES
       WHERE PROCESSED = 0
       ORDER BY EFFECTIVEDATE`,
      {
        type: QueryTypes.SELECT,
      }
    );

    return res.status(200).json({
      success: true,
      data: {
        total: pendingChanges.length,
        changes: pendingChanges,
      },
    });
  } catch (error) {
    console.error('[Monitoring] getPendingModeChanges error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

module.exports = {
  getHealthStatus,
  getJobHistory,
  getPendingModeChanges,
};  