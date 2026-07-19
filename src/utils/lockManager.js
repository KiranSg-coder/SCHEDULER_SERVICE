// src/utils/lockManager.js
const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');

class LockManager {
  async checkLock(userId, dayDate) {
    console.log(`[LockManager] Checking lock for userId=${userId}, dayDate=${dayDate}`);
    const result = await sequelize.query(
      `EXEC USP_CHECK_DAY_LOCK 
        @USERID = :userId,
        @DAYDATE = :dayDate`,
      {
        replacements: { userId, dayDate },
        type: QueryTypes.SELECT,
      }
    );
    console.log(`[LockManager] checkLock raw result:`, JSON.stringify(result));
    return result[0];
  }

  async createLock(userId, dayDate, lockedBy = 'scheduler') {
    const result = await sequelize.query(
      `EXEC USP_CREATE_DAY_LOCK 
        @USERID = :userId,
        @DAYDATE = :dayDate,
        @LOCKEDBY = :lockedBy`,
      {
        replacements: { userId, dayDate, lockedBy },
        type: QueryTypes.SELECT,
      }
    );
    return result[0]?.LockId;
  }

  async releaseLock(userId, dayDate, dayId) {
    console.log(`[LockManager] Releasing lock for userId=${userId}, dayDate=${dayDate}, dayId=${dayId}`);
    await sequelize.query(
      `EXEC USP_RELEASE_DAY_LOCK 
        @USERID = :userId,
        @DAYDATE = :dayDate,
        @DAYID = :dayId`,
      {
        replacements: { userId, dayDate, dayId },
        type: QueryTypes.UPDATE,
      }
    );
    console.log(`[LockManager] Lock released for userId=${userId}`);
  }
}

module.exports = new LockManager();