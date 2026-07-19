# Scheduler Service & Database — Review

**Reviewed:** SCHEDULER microservice + SCHEDULER_SERVICE MSSQL database and stored procedures  
**Aligned to:** P-OS BRD (day boundary, create day, close day, evaluate day, mode change, 14-day lock)

---

## 1. Service Overview

| Item | Value |
|------|--------|
| **Stack** | Node.js, Express, Sequelize, MSSQL, node-cron, Axios |
| **Default port** | 5004 (was 3004; aligned with 5000–5002) |
| **Gateway path** | `/scheduler` → pathRewrite to `` (e.g. `POST /scheduler/webhook/mode-change` → Scheduler `POST /webhook/mode-change`) |

**Route summary**

| Method | Path | Purpose |
|--------|------|---------|
| POST | /webhook/mode-change | Receive mode change from Discipline Rule Engine (MINIMUM / RECOVERY); store in PENDING_MODE_CHANGES. |
| GET | /internal/health | Health check (DB connectivity). |
| GET | /internal/jobs/history | Job execution history (optional query: limit, jobType). |
| GET | /internal/mode-changes/pending | List pending mode changes (PROCESSED = 0). |

**Cron jobs (every minute)**

| Job | Purpose |
|-----|---------|
| **createDailyInstances** | Users whose day starts now → lock → pending mode change → active ruleset → create day in Daily Execution → release lock → update boundaries (Rule Management) → mark mode processed → notify. |
| **closeDays** | Users whose day ends now → get today’s day → close day in Daily Execution → enqueue for evaluation (EVALUATION_QUEUE). |
| **evaluateDays** | PENDING rows in EVALUATION_QUEUE → call Discipline Rule Engine evaluate → mark COMPLETED or retry / FAILED. |
| **activateRulesets** | Call Rule Management activate-pending rulesets. |

---

## 2. Database Schema — Alignment with BRD

### 2.1 Tables

1. **DAY_CREATION_LOCK** — One row per (USERID, DAYDATE). LOCKID, LOCKEDAT, LOCKEDBY, RELEASEDAT, DAYID. Prevents duplicate day creation.  
   **BRD:** One day per user per calendar day.

2. **EVALUATION_QUEUE** — One row per day to evaluate. DAYID (unique), USERID, DAYDATE, CLOSEDAT, EVALUATIONSTATUS (PENDING | EVALUATING | COMPLETED | FAILED), EVALUATIONATTEMPTS, LASTATTEMPT, EVALUATEDAT, EVALUATIONID.  
   **BRD:** Close day → queue → Discipline Rule Engine evaluates.

3. **FAILED_OPERATIONS** — OPERATIONTYPE, USERID, TARGETDATE, PAYLOAD, FAILUREREASON, RETRYCOUNT, MAXRETRIES, NEXTRETRYAT, STATUS (PENDING_RETRY | RETRYING | RESOLVED | ABANDONED). For retry tracking (optional use).  

4. **JOB_EXECUTION_LOG** — JOBTYPE (CREATE_DAY | CLOSE_DAY | EVALUATE_DAY | ACTIVATE_RULESET), USERID, TARGETDATE, STATUS (PENDING | RUNNING | SUCCESS | FAILED | SKIPPED), STARTEDAT, COMPLETEDAT, DURATIONMS, ERRORCODE, ERRORMESSAGE, RETRYCOUNT, METADATA.  
   **BRD:** Audit and monitoring.

5. **PENDING_MODE_CHANGES** — USERID, NEWMODE (STANDARD | MINIMUM), PREVIOUSMODE, REASON, EFFECTIVEDATE, MODECHANGEID, MINIMUMRULEIDS, PROCESSED, PROCESSEDAT, CREATEDDAYID. Unique (USERID, EFFECTIVEDATE).  
   **BRD:** Discipline Rule Engine notifies Scheduler via webhook; Scheduler applies mode when creating the next day.

---

## 3. Stored Procedures — Summary

| SP | Purpose |
|----|---------|
| **USP_CHECK_DAY_LOCK** | Returns LockExists (0/1), DAYID, LOCKEDBY, LOCKEDAT for (USERID, DAYDATE). |
| **USP_CREATE_DAY_LOCK** | Insert DAY_CREATION_LOCK; return LockId. |
| **USP_RELEASE_DAY_LOCK** | Set RELEASEDAT, DAYID for (USERID, DAYDATE). |
| **USP_GET_PENDING_MODE_CHANGE** | Select unprocessed PENDING_MODE_CHANGES for (USERID, EFFECTIVEDATE). |
| **USP_STORE_MODE_CHANGE** | Insert or update PENDING_MODE_CHANGES (upsert by USERID, EFFECTIVEDATE, PROCESSED=0). |
| **USP_MARK_MODE_CHANGE_PROCESSED** | Set PROCESSED=1, PROCESSEDAT, CREATEDDAYID for (USERID, EFFECTIVEDATE). |
| **USP_LOG_JOB_START** | Insert JOB_EXECUTION_LOG (RUNNING); return ExecutionId. |
| **USP_LOG_JOB_SUCCESS** | Update log: STATUS=SUCCESS, COMPLETEDAT, DURATIONMS, METADATA. |
| **USP_LOG_JOB_FAILURE** | Update log: STATUS=FAILED, COMPLETEDAT, DURATIONMS, ERRORCODE, ERRORMESSAGE. |

EVALUATION_QUEUE is written by the **Node job** (raw INSERT in closeDays.js), not by an SP.

---

## 4. Core Service Integration (Scheduler ↔ other services)

All URLs below use **direct service ports** (no gateway) for server-to-server calls. Ensure `.env` matches the ports each service actually runs on.

| Scheduler calls | Service | URL env | Endpoints used |
|-----------------|---------|---------|----------------|
| **Rule Management** | Rule Management | `RULE_MANAGEMENT_URL` | GET /internal/ruleset/users-day-start, GET /internal/ruleset/users-day-end, GET /ruleset/active, POST /internal/ruleset/activate-pending; POST /internal/ruleset/update-boundaries (from createDailyInstances). |
| **Daily Execution** | Daily Execution | `DAILY_EXECUTION_URL` | POST /internal/day/create, POST /internal/day/close, GET /day/today. |
| **Discipline Rule Engine** | Discipline Rule Engine | `RULE_ENGINE_URL` | POST /internal/evaluate. |
| **Notification** | Notification | `NOTIFICATION_URL` | Used by notificationService.sendDayStartNotification (implementation in notificationService). |

| Service calls Scheduler | Endpoint | Used by |
|-------------------------|----------|---------|
| **Discipline Rule Engine** | POST /webhook/mode-change | After 3-fail → MINIMUM or 3-pass → RECOVERY; body: userId, newMode, reason, effectiveDate, modeChangeId, minimumRuleIds. |

**Recommended .env (direct service ports):**

- `RULE_MANAGEMENT_URL=http://localhost:5000`
- `DAILY_EXECUTION_URL=http://localhost:5001`
- `RULE_ENGINE_URL=http://localhost:5002`
- `NOTIFICATION_URL=http://localhost:5005` (or the port your Notification service uses)
- `INTERNAL_SERVICE_KEY=<shared-secret>` (same as used by Rule Management, Daily Execution, Discipline for X-Service-Key)

---

## 5. Flow Checklist (BRD)

| BRD / flow | Where |
|------------|-------|
| Day start boundary | Rule Management internal users-day-start (per user day start) → createDailyInstances. |
| Day end boundary | Rule Management internal users-day-end → closeDays. |
| Create day (lock, mode, rules) | createDailyInstances: lock → pending mode → active ruleset → transform by mode → Daily Execution create → release lock → Rule Management update-boundaries → mark mode processed → notify. |
| Close day | closeDays: get today → Daily Execution close → insert EVALUATION_QUEUE. |
| Evaluate day | evaluateDays: EVALUATION_QUEUE PENDING → Discipline Rule Engine evaluate → mark COMPLETED/retry/FAILED. |
| Mode change (3-fail / recovery) | Discipline Rule Engine → POST /webhook/mode-change → PENDING_MODE_CHANGES; next create day uses USP_GET_PENDING_MODE_CHANGE and applies NEWMODE. |
| Activate pending rulesets | activateRulesets job → Rule Management activate-pending. |

---

## 6. Gaps / Recommendations

### 6.1 Root route

- **index.js:** `app.use("/", ...)` catches all methods and paths. Use `app.get("/", ...)` so only GET / returns the welcome message and routes under /webhook and /internal work correctly. **Fixed in this pass.**

### 6.2 Database config

- **database.js:** Uses hardcoded host and credentials. Prefer `process.env.DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` from .env. **Recommended in review; optional code change.**

### 6.3 calculateDayNumber (createDailyInstances.js)

- Uses `[DAILY_EXECUTION].[dbo].[USERDAY]` via the Scheduler’s Sequelize connection. That connection is to **SCHEDULER_SERVICE**; the three-part name requires the SQL login to have access to **DAILY_EXECUTION** on the same server. If not, the query will fail. Alternatives: (1) ensure the same server and login can read DAILY_EXECUTION, or (2) add a small “day count” or “last day number” endpoint on Daily Execution and call it from Scheduler.

### 6.4 MINIMUMRULEIDS format

- **USP_STORE_MODE_CHANGE** accepts MINIMUMRULEIDS NVARCHAR(200). Webhook controller passes `JSON.stringify(minimumRuleIds)` (e.g. "[1,4]"). If Rule Management or ruleTransformer expects comma-separated "1,4", ensure consistency (e.g. store "1,4" or parse in ruleTransformer).

### 6.5 Job load order

- **index.js** requires job files (createDailyInstances, closeDays, evaluateDays, activateRulesets) **before** mounting routes. That is correct so crons start; ensure routes are mounted after so /webhook and /internal are available.

### 6.6 EVALUATION_QUEUE status after evaluate

- evaluateDays expects `evaluationResult.evaluationId` and `evaluationResult.result`. Ensure Discipline Rule Engine response shape matches (e.g. `data.evaluationId`, `data.result`).

---

## 7. API Gateway Integration

**Done:**

- **Proxy:** Requests to `/scheduler/*` are forwarded to Scheduler (default `http://localhost:5004`) with `pathRewrite: { "^/scheduler": "" }`.
- **Examples:**
  - `POST /scheduler/webhook/mode-change` — body: userId, newMode, reason, effectiveDate, modeChangeId, minimumRuleIds (called by Discipline Rule Engine).
  - `GET /scheduler/internal/health`
  - `GET /scheduler/internal/jobs/history?limit=50&jobType=CREATE_DAY`
  - `GET /scheduler/internal/mode-changes/pending`

**Port:** Scheduler runs on **5004** by default. Set `PORT=5004` in `.env` if needed.

**Note:** Scheduler’s **outbound** calls to Rule Management, Daily Execution, and Discipline Rule Engine use the **service URLs in .env** (direct ports 5000, 5001, 5002). They do not go through the gateway. Only external clients (e.g. Discipline Rule Engine) calling the Scheduler use the gateway when deployed behind it (e.g. `GATEWAY_URL/webhook/mode-change` with pathRewrite so Scheduler receives `/webhook/mode-change`). If Discipline calls Scheduler directly, set Discipline’s `SCHEDULER_SERVICE_URL=http://localhost:5004`; if through gateway, set `SCHEDULER_SERVICE_URL=http://localhost:<GATEWAY_PORT>/scheduler`.

---

## 8. Next Steps

1. Use DB_* env in database.js.
2. Confirm SQL login can read DAILY_EXECUTION.dbo.USERDAY for calculateDayNumber, or switch to Daily Execution API.
3. Align MINIMUMRULEIDS format (webhook store vs ruleTransformer).
4. Add integration test: webhook mode-change → create day (with mock Rule Management / Daily Execution) and verify mode applied.
5. Document NOTIFICATION_URL and Notification service contract (sendDayStartNotification).

---

*End of Scheduler review. Service is integrated at `/scheduler`. Core service URLs and root route have been updated for correct integration.*
