# Task storage and ownership

Current behavior on master. Task Center, CRM follow-ups, Marco operational tasks and automation enrollment state remain distinct.

## Stores

| System | Storage | Implementation | API/UI |
| --- | --- | --- | --- |
| Command / Task Center tasks | shared-tasks.db when ACCOUNT_ISOLATION=true; legacy commandTasks JSON otherwise | core/sharedTasks.ts and core/db.ts | /api/tasks; /team-tasks; /tasks redirects to /team-tasks |
| CRM follow-up tasks | Account-local tasks.json | core/tasks.ts | /api/crm-tasks; CRM follow-up views |
| Marco operational tasks | Account-local marco-tasks.json | core/marcoTasks.ts | /api/marco-tasks |
| Auto-plan definitions | Account-local auto-plans.json | core/autoPlans.ts | /api/auto-plans |
| Lead auto-plan progress | Lead.autoPlanEnrollments in the CRM JSON store | core/db.ts and server.ts | Lead profile and enrollment routes |
| Transaction auto-plan progress | Transaction store | core/transactionsStore.ts and server.ts | Transaction plan routes |

The classic command board remains at /tasks-classic. Current type definitions live in src/core/types.ts; do not use older documentation shapes as a complete schema.

## Shared Task Center

With account isolation, core/db.ts delegates command-task reads/writes to core/sharedTasks.ts. The shared SQLite database uses WAL, FULL synchronization, transactional updates, import tracking and revision history. Deletes are soft deletes.

Marco and Wesley see/edit tasks assigned to them. Carlos sees/edits all three members' tasks. The server takes creator attribution from the authenticated actor, independently of assignee. Task requests use the signed-in actor even when another account owns a business record being viewed.

Recovery imports retained root/account command tasks once per source record, preserving source files. Existing edits and explicit deletions are not overwritten on subsequent recovery. Deadline automation compares the original status/date/update snapshot before changing a task.

## Account-local paths

dataPath() uses TENANT_DATA_ROOT when supplied, otherwise /data if present, otherwise ./data. The gateway gives each account a hashed directory and passes SHARED_TASK_DB_PATH explicitly.

The CRM JSON resolver uses DB_JSON_PATH when configured, otherwise an existing dataPath("db.json"), otherwise dataPath("local-dashboard-db.json"). tasks.json and auto-plans.json follow their resolver's CRM-directory rules unless explicitly overridden. See TASKS_JSON_PATH and AUTO_PLANS_JSON_PATH in the respective modules.

Do not assume that /data/db.json is a signed-in user's CRM or that every task is JSON-backed.

## Auto plans and linked tasks

Plan definitions and enrollment progress are separate. Due task steps create CRM follow-up tasks, not Task Center tasks. The server schedules lead and transaction auto-plan execution hourly. Email/text steps require the relevant configured sending channel and merge-field validation.

Tracker checklist links use core/trackerTasks.ts and the command-task APIs. Read the link/synchronization helpers before changing checklist behavior; do not merge task stores to make their counts agree.

## Authentication and summaries

Account isolation requires authenticated routing; shared tokens do not bypass account ownership. Route-level checks remain in src/server.ts.

GET /api/dashboard/data exposes separate task summaries. Carlos's combined dashboard uses the shared command-task summary once rather than summing it across workers.

Harvey Work jobs and schedules are separate records in harvey-work/work.db. They are not CRM tasks or Task Center rows.

## Verification references

Use the relevant fixture scripts: verify-account-isolation.mjs, verify-team-access.mjs, verify-team-data.mjs, verify-task-owner-recovery.mjs, verify-task-attribution-repair.mjs and verify-task-checklist-persistence.mjs. Inspect migration/repair scripts before executing them; some are intended to change retained data.
