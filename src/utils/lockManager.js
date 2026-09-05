// src/utils/lockManager.js
//
// Day-creation locking.
//
// Previously checkLock() + createLock() were two separate statements with no
// transaction (a race between Scheduler instances), and releaseLock() only
// stamped RELEASEDAT while checkLock() tested for row existence — so a released
// lock stayed held forever and a failed day could never be retried.
//
// claimDay() is now a single atomic call. Release deletes the row on failure so
// the next tick retries, and stamps it on success so the day is never duplicated.
const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');

const STALE_LOCK_MINUTES = Number(process.env.DAY_LOCK_STALE_MINUTES || 10);

class LockManager {
  /**
   * Atomically claim the right to create a day.
   * @returns {Promise<{claimed:boolean, alreadyCreated:boolean, inFlight:boolean,
   *                    lockId:number|null, existingDayId:number|null}>}
   */
  async claimDay(userId, dayDate, lockedBy = 'scheduler') {
    const rows = await sequelize.query(
      `EXEC USP_CLAIM_DAY_LOCK
        @USERID = :userId,
        @DAYDATE = :dayDate,
        @LOCKEDBY = :lockedBy,
        @STALEMINUTES = :staleMinutes`,
      {
        replacements: { userId, dayDate, lockedBy, staleMinutes: STALE_LOCK_MINUTES },
        type: QueryTypes.SELECT,
      },
    );

    const r = rows?.[0] || {};

    if (r.ErrorCode && r.ErrorCode !== 0) {
      throw new Error(`USP_CLAIM_DAY_LOCK failed: ${r.ErrorMessage}`);
    }

    return {
      claimed: Boolean(r.Claimed),
      alreadyCreated: Boolean(r.AlreadyCreated),
      inFlight: Boolean(r.InFlight),
      lockId: r.LockId ?? null,
      existingDayId: r.ExistingDayId ?? null,
    };
  }

  /**
   * Finish an attempt.
   * @param {number|null} dayId — the created day, or null when the attempt failed.
   *   null DELETES the lock row so the next tick can retry.
   */
  async releaseLock(userId, dayDate, dayId = null) {
    await sequelize.query(
      `EXEC USP_RELEASE_DAY_LOCK
        @USERID = :userId,
        @DAYDATE = :dayDate,
        @DAYID = :dayId`,
      {
        replacements: { userId, dayDate, dayId: dayId ?? null },
        type: QueryTypes.SELECT,
      },
    );
  }

  /** Read-only: has a day actually been created for this (user, date)? */
  async checkLock(userId, dayDate) {
    const result = await sequelize.query(
      `EXEC USP_CHECK_DAY_LOCK
        @USERID = :userId,
        @DAYDATE = :dayDate`,
      {
        replacements: { userId, dayDate },
        type: QueryTypes.SELECT,
      },
    );
    return result[0];
  }

  /** @deprecated use claimDay() — kept so nothing breaks if another job calls it. */
  async createLock(userId, dayDate, lockedBy = 'scheduler') {
    const claim = await this.claimDay(userId, dayDate, lockedBy);
    return claim.lockId;
  }
}

module.exports = new LockManager();
