/*==============================================================
  SCHEDULER V2 — day-lock correctness + durable mode changes

    1. DAY_CREATION_LOCK unique index (atomic claim)
    2. USP_CLAIM_DAY_LOCK        (new — atomic, stale-aware)
    3. USP_RELEASE_DAY_LOCK      (rewritten — deletes on failure)
    4. USP_CHECK_DAY_LOCK        (rewritten — honours RELEASEDAT/DAYID)
    5. USP_GET_PENDING_MODE_CHANGE   (<= date, newest wins)
    6. USP_MARK_MODE_CHANGE_PROCESSED (supersedes stale rows)
    7. USP_STORE_MODE_CHANGE     (idempotent upsert by MODECHANGEID)
    8. USP_GET_PROGRESSION_HEALTH (read-only detectors)

  Idempotent. Safe to re-run.
==============================================================*/
USE [SCHEDULER_SERVICE]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

--==============================================================
-- 1. Uniqueness on (USERID, DAYDATE).
--
--    The base schema already ships CONSTRAINT UQ_DAY_LOCK_USER_DATE, so this
--    is normally a no-op. It is kept as a guard for environments provisioned
--    before that constraint existed. Duplicates are collapsed first, keeping
--    the row that actually produced a day.
--
--    Note: because this constraint already exists, the OLD code path was doubly
--    broken — USP_CREATE_DAY_LOCK's plain INSERT threw a duplicate-key error on
--    any retry, and USP_CHECK_DAY_LOCK reported the released row as still held.
--    A failed day was unrecoverable by either route.
--==============================================================
IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE object_id = OBJECT_ID('dbo.DAY_CREATION_LOCK')
      AND is_unique = 1
      AND EXISTS (
          SELECT 1 FROM sys.index_columns ic
          JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
          WHERE ic.object_id = sys.indexes.object_id
            AND ic.index_id = sys.indexes.index_id
            AND c.name = 'USERID'
      )
      AND EXISTS (
          SELECT 1 FROM sys.index_columns ic
          JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
          WHERE ic.object_id = sys.indexes.object_id
            AND ic.index_id = sys.indexes.index_id
            AND c.name = 'DAYDATE'
      )
)
BEGIN
    ;WITH dupes AS (
        SELECT LOCKID,
               ROW_NUMBER() OVER (PARTITION BY USERID, DAYDATE
                                  ORDER BY CASE WHEN DAYID IS NOT NULL THEN 0 ELSE 1 END,
                                           LOCKID DESC) AS rn
        FROM dbo.DAY_CREATION_LOCK
    )
    DELETE FROM dupes WHERE rn > 1;

    CREATE UNIQUE INDEX UQ_DAY_CREATION_LOCK_USER_DATE
        ON dbo.DAY_CREATION_LOCK (USERID, DAYDATE);
END
GO

--==============================================================
-- 2. USP_CLAIM_DAY_LOCK
--
--    Atomic claim. Returns exactly one row:
--      Claimed        1 = caller owns the lock and must create the day
--      AlreadyCreated 1 = a day already exists for this (user, date)
--      InFlight       1 = another worker holds a fresh, unreleased lock
--
--    A lock with DAYID IS NULL older than @STALEMINUTES is taken over,
--    which is what makes retry-after-failure possible (AR-1).
--==============================================================
CREATE OR ALTER PROCEDURE [dbo].[USP_CLAIM_DAY_LOCK]
(
    @USERID INT,
    @DAYDATE DATE,
    @LOCKEDBY NVARCHAR(100) = 'scheduler',
    @STALEMINUTES INT = 10
)
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @LockId INT, @ExistingDayId INT, @LockedAt DATETIME2, @ReleasedAt DATETIME2;
    DECLARE @Claimed BIT = 0, @AlreadyCreated BIT = 0, @InFlight BIT = 0;

    BEGIN TRY
        BEGIN TRANSACTION;

        SELECT @LockId = LOCKID, @ExistingDayId = DAYID,
               @LockedAt = LOCKEDAT, @ReleasedAt = RELEASEDAT
        FROM dbo.DAY_CREATION_LOCK WITH (UPDLOCK, HOLDLOCK)
        WHERE USERID = @USERID AND DAYDATE = @DAYDATE;

        IF @LockId IS NULL
        BEGIN
            INSERT INTO dbo.DAY_CREATION_LOCK (USERID, DAYDATE, LOCKEDBY, LOCKEDAT)
            VALUES (@USERID, @DAYDATE, @LOCKEDBY, SYSUTCDATETIME());
            SET @LockId = SCOPE_IDENTITY();
            SET @Claimed = 1;
        END
        ELSE IF @ExistingDayId IS NOT NULL
        BEGIN
            -- The day genuinely exists. Never create a second one.
            SET @AlreadyCreated = 1;
        END
        ELSE IF @LockedAt IS NULL
             OR DATEDIFF(MINUTE, @LockedAt, SYSUTCDATETIME()) >= @STALEMINUTES
        BEGIN
            -- Abandoned attempt (crash, timeout, released-without-day). Take it over.
            UPDATE dbo.DAY_CREATION_LOCK
            SET LOCKEDBY = @LOCKEDBY, LOCKEDAT = SYSUTCDATETIME(), RELEASEDAT = NULL
            WHERE LOCKID = @LockId;
            SET @Claimed = 1;
        END
        ELSE IF @ReleasedAt IS NOT NULL
        BEGIN
            -- Released without producing a day => the attempt failed. Retry now.
            UPDATE dbo.DAY_CREATION_LOCK
            SET LOCKEDBY = @LOCKEDBY, LOCKEDAT = SYSUTCDATETIME(), RELEASEDAT = NULL
            WHERE LOCKID = @LockId;
            SET @Claimed = 1;
        END
        ELSE
        BEGIN
            SET @InFlight = 1;
        END

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;

        -- Unique-index violation: another worker won the race. Not an error.
        IF ERROR_NUMBER() IN (2601, 2627)
        BEGIN
            SET @Claimed = 0;
            SET @InFlight = 1;
        END
        ELSE
        BEGIN
            SELECT 0 AS Claimed, 0 AS AlreadyCreated, 0 AS InFlight,
                   NULL AS LockId, NULL AS ExistingDayId,
                   99 AS ErrorCode, ERROR_MESSAGE() AS ErrorMessage;
            RETURN;
        END
    END CATCH

    SELECT @Claimed AS Claimed,
           @AlreadyCreated AS AlreadyCreated,
           @InFlight AS InFlight,
           @LockId AS LockId,
           @ExistingDayId AS ExistingDayId,
           0 AS ErrorCode,
           NULL AS ErrorMessage;
END
GO

--==============================================================
-- 3. USP_RELEASE_DAY_LOCK
--    Success (@DAYID supplied) -> stamp the row; it becomes the
--      permanent "this day exists" marker.
--    Failure (@DAYID NULL)     -> DELETE the row so the next tick
--      can retry immediately. This is the AR-1 fix.
--==============================================================
CREATE OR ALTER PROCEDURE [dbo].[USP_RELEASE_DAY_LOCK]
(
    @USERID INT,
    @DAYDATE DATE,
    @DAYID INT = NULL
)
AS
BEGIN
    SET NOCOUNT ON;

    IF @DAYID IS NULL
    BEGIN
        DELETE FROM dbo.DAY_CREATION_LOCK
        WHERE USERID = @USERID AND DAYDATE = @DAYDATE AND DAYID IS NULL;
    END
    ELSE
    BEGIN
        UPDATE dbo.DAY_CREATION_LOCK
        SET RELEASEDAT = SYSUTCDATETIME(), DAYID = @DAYID
        WHERE USERID = @USERID AND DAYDATE = @DAYDATE;
    END

    SELECT @@ROWCOUNT AS AffectedRows;
END
GO

--==============================================================
-- 4. USP_CHECK_DAY_LOCK (kept for compatibility)
--    LockExists now means "a day was actually created", not
--    "a row exists in the lock table".
--==============================================================
CREATE OR ALTER PROCEDURE [dbo].[USP_CHECK_DAY_LOCK]
(
    @USERID INT,
    @DAYDATE DATE
)
AS
BEGIN
    SET NOCOUNT ON;

    IF EXISTS (
        SELECT 1 FROM dbo.DAY_CREATION_LOCK
        WHERE USERID = @USERID AND DAYDATE = @DAYDATE AND DAYID IS NOT NULL
    )
    BEGIN
        SELECT 1 AS LockExists, DAYID, LOCKEDBY, LOCKEDAT, RELEASEDAT
        FROM dbo.DAY_CREATION_LOCK
        WHERE USERID = @USERID AND DAYDATE = @DAYDATE;
    END
    ELSE
    BEGIN
        SELECT 0 AS LockExists, NULL AS DAYID, NULL AS LOCKEDBY,
               NULL AS LOCKEDAT, NULL AS RELEASEDAT;
    END
END
GO

--==============================================================
-- 5. USP_GET_PENDING_MODE_CHANGE
--    AR-2: <= instead of =, newest unprocessed row wins, so a mode
--    change survives any gap in day creation.
--==============================================================
CREATE OR ALTER PROCEDURE [dbo].[USP_GET_PENDING_MODE_CHANGE]
(
    @USERID INT,
    @EFFECTIVEDATE DATE
)
AS
BEGIN
    SET NOCOUNT ON;

    SELECT TOP 1
        CHANGELOGID, USERID, NEWMODE, PREVIOUSMODE, REASON,
        EFFECTIVEDATE, MODECHANGEID, MINIMUMRULEIDS
    FROM dbo.PENDING_MODE_CHANGES
    WHERE USERID = @USERID
      AND EFFECTIVEDATE <= @EFFECTIVEDATE
      AND PROCESSED = 0
    ORDER BY EFFECTIVEDATE DESC, CHANGELOGID DESC;
END
GO

--==============================================================
-- 6. USP_MARK_MODE_CHANGE_PROCESSED
--    Marks the applied row AND supersedes every older unprocessed
--    row, so stale entries can never resurface.
--==============================================================
CREATE OR ALTER PROCEDURE [dbo].[USP_MARK_MODE_CHANGE_PROCESSED]
(
    @USERID INT,
    @EFFECTIVEDATE DATE,
    @CREATEDDAYID INT = NULL
)
AS
BEGIN
    SET NOCOUNT ON;

    UPDATE dbo.PENDING_MODE_CHANGES
    SET PROCESSED = 1,
        PROCESSEDAT = SYSUTCDATETIME(),
        CREATEDDAYID = @CREATEDDAYID
    WHERE USERID = @USERID
      AND EFFECTIVEDATE <= @EFFECTIVEDATE
      AND PROCESSED = 0;

    SELECT @@ROWCOUNT AS AffectedRows;
END
GO

--==============================================================
-- 7. USP_STORE_MODE_CHANGE
--    Idempotent on MODECHANGEID so the reconciliation job can replay
--    safely without creating duplicates.
--==============================================================
CREATE OR ALTER PROCEDURE [dbo].[USP_STORE_MODE_CHANGE]
(
    @USERID INT,
    @NEWMODE NVARCHAR(20),
    @PREVIOUSMODE NVARCHAR(20),
    @REASON NVARCHAR(500),
    @EFFECTIVEDATE DATE,
    @MODECHANGEID INT = NULL,
    @MINIMUMRULEIDS NVARCHAR(200) = NULL
)
AS
BEGIN
    SET NOCOUNT ON;

    IF @MODECHANGEID IS NOT NULL
       AND EXISTS (SELECT 1 FROM dbo.PENDING_MODE_CHANGES WHERE MODECHANGEID = @MODECHANGEID)
    BEGIN
        SELECT 0 AS Inserted, 1 AS AlreadyPresent,
               (SELECT TOP 1 CHANGELOGID FROM dbo.PENDING_MODE_CHANGES
                WHERE MODECHANGEID = @MODECHANGEID) AS ChangeLogId;
        RETURN;
    END

    -- MODECHANGEID and CREATEDDATE are NOT NULL in PENDING_MODE_CHANGES.
    -- A replay always supplies the id; a direct webhook might not.
    DECLARE @SafeModeChangeId INT = ISNULL(@MODECHANGEID, 0);
    DECLARE @Now DATETIME2 = SYSUTCDATETIME();

    IF EXISTS (
        SELECT 1 FROM dbo.PENDING_MODE_CHANGES
        WHERE USERID = @USERID AND EFFECTIVEDATE = @EFFECTIVEDATE AND PROCESSED = 0
    )
    BEGIN
        UPDATE dbo.PENDING_MODE_CHANGES
        SET NEWMODE = @NEWMODE,
            PREVIOUSMODE = @PREVIOUSMODE,
            REASON = @REASON,
            MODECHANGEID = CASE WHEN @MODECHANGEID IS NULL THEN MODECHANGEID
                                ELSE @MODECHANGEID END,
            MINIMUMRULEIDS = @MINIMUMRULEIDS,
            RECEIVEDAT = @Now
        WHERE USERID = @USERID AND EFFECTIVEDATE = @EFFECTIVEDATE AND PROCESSED = 0;

        SELECT 0 AS Inserted, 1 AS AlreadyPresent,
               (SELECT TOP 1 CHANGELOGID FROM dbo.PENDING_MODE_CHANGES
                WHERE USERID = @USERID AND EFFECTIVEDATE = @EFFECTIVEDATE AND PROCESSED = 0)
               AS ChangeLogId;
    END
    ELSE
    BEGIN
        INSERT INTO dbo.PENDING_MODE_CHANGES
            (USERID, NEWMODE, PREVIOUSMODE, REASON, EFFECTIVEDATE,
             MODECHANGEID, MINIMUMRULEIDS, PROCESSED, RECEIVEDAT, CREATEDDATE)
        VALUES
            (@USERID, @NEWMODE, @PREVIOUSMODE, @REASON, @EFFECTIVEDATE,
             @SafeModeChangeId, @MINIMUMRULEIDS, 0, @Now, @Now);

        SELECT 1 AS Inserted, 0 AS AlreadyPresent, SCOPE_IDENTITY() AS ChangeLogId;
    END
END
GO

--==============================================================
-- 8. USP_GET_PROGRESSION_HEALTH — read-only detectors (Phase 0)
--==============================================================
CREATE OR ALTER PROCEDURE [dbo].[USP_GET_PROGRESSION_HEALTH]
(
    @STALLDAYS INT = 2
)
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Cutoff DATE = DATEADD(DAY, -@STALLDAYS, CAST(SYSUTCDATETIME() AS DATE));

    -- Rule sets that should be producing days but are not
    SELECT
        'STALLED_RULESET' AS Signal,
        RS.USERID, RS.RULESETID, RS.CHALLENGELEVEL,
        RS.NEXTDAYSTARTUTC, RS.SETUPBLOCKING, RS.NEEDSSETUP,
        (SELECT MAX(UD.DAYDATE) FROM DAILY_EXECUTION.dbo.USERDAY UD
         WHERE UD.USERID = RS.USERID) AS LastDayDate
    FROM RULE_MANAGEMENT.dbo.RULE_SET RS
    WHERE RS.ACTIVE = 1 AND RS.STATUS = 'ACTIVE'
      AND ISNULL(RS.SETUPBLOCKING, 0) = 0
      AND (
            (SELECT MAX(UD.DAYDATE) FROM DAILY_EXECUTION.dbo.USERDAY UD
             WHERE UD.USERID = RS.USERID) < @Cutoff
         OR NOT EXISTS (SELECT 1 FROM DAILY_EXECUTION.dbo.USERDAY UD WHERE UD.USERID = RS.USERID)
      );

    -- Drafts waiting on the user
    SELECT
        'BLOCKED_DRAFT' AS Signal,
        RS.USERID, RS.RULESETID, RS.CHALLENGELEVEL, RS.CREATEDDATE,
        DATEDIFF(DAY, RS.CREATEDDATE, SYSUTCDATETIME()) AS AgeDays
    FROM RULE_MANAGEMENT.dbo.RULE_SET RS
    WHERE RS.ACTIVE = 1 AND RS.STATUS = 'ACTIVE'
      AND ISNULL(RS.SETUPBLOCKING, 0) = 1;

    -- Users with no active rule set at all
    SELECT
        'STRANDED_USER' AS Signal,
        RS.USERID, MAX(RS.RULESETID) AS LastRulesetId, MAX(RS.COMPLETEDAT) AS LastCompletedAt
    FROM RULE_MANAGEMENT.dbo.RULE_SET RS
    WHERE RS.STATUS = 'COMPLETED'
      AND NOT EXISTS (
          SELECT 1 FROM RULE_MANAGEMENT.dbo.RULE_SET A
          WHERE A.USERID = RS.USERID AND A.ACTIVE = 1 AND A.STATUS = 'ACTIVE')
    GROUP BY RS.USERID;

    -- Mode changes decided but never delivered to the Scheduler
    SELECT
        'UNDELIVERED_MODE_CHANGE' AS Signal,
        MCH.USERID, MCH.MODECHANGEID, MCH.NEWMODE, MCH.PREVIOUSMODE,
        MCH.CHANGEREASON, MCH.EFFECTIVEDATE
    FROM DISCIPLINE_RULE_ENGINE.dbo.MODECHANGEHISTORY MCH
    WHERE MCH.EFFECTIVEDATE >= DATEADD(DAY, -30, CAST(SYSUTCDATETIME() AS DATE))
      AND NOT EXISTS (
          SELECT 1 FROM dbo.PENDING_MODE_CHANGES P
          WHERE P.MODECHANGEID = MCH.MODECHANGEID
      );
END
GO

PRINT 'SCHEDULER V2 applied.';
GO
