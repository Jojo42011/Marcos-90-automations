# Marco System — Task Management Data Storage

Reference for agents (Claude, Harvey, etc.) working on Marco Puga's automation dashboard (`marco-90-automation`).

**Important:** Task management is **not one database table**. There are **four separate task stores** plus **auto-plan enrollments on leads**. They serve different UI surfaces and must not be conflated.

---

## Storage overview

| System | Purpose | Storage file | In-memory module | Primary UI |
|--------|---------|--------------|------------------|------------|
| **Command tasks** | Carlos / ops kanban board | `db.json` → `commandTasks[]` | `src/core/db.ts` | `/tasks` (`tasks.html`) |
| **CRM follow-up tasks** | Lead-linked follow-ups | `tasks.json` (sibling of db) | `src/core/tasks.ts` | CRM dashboard → Follow-up Tasks tab |
| **Marco tasks** | Marco operational to-dos (non-lead) | `marco-tasks.json` | `src/core/marcoTasks.ts` | CRM dashboard → Marco Tasks panel |
| **Auto plans** | Drip campaign definitions | `auto-plans.json` | `src/core/autoPlans.ts` | CRM → Auto Plans |
| **Auto plan enrollments** | Per-lead drip progress | `db.json` → `leadsById[id].autoPlanEnrollments` | `src/core/db.ts` | CRM lead profile |

---

## Path resolution (local vs Fly)

All paths are resolved at runtime from env + filesystem:

| Env var | Effect |
|---------|--------|
| `DB_JSON_PATH` | Explicit path to main CRM JSON |
| `TASKS_JSON_PATH` | Explicit path to CRM follow-up tasks (overrides sibling rule) |
| `AUTO_PLANS_JSON_PATH` | Explicit path to auto plans (default: sibling of db) |

**Fly production** (volume mounted at `/data`):

- `/data/db.json` — leads, conversations, command tasks
- `/data/tasks.json` — CRM follow-up tasks
- `/data/marco-tasks.json` — Marco operational tasks
- `/data/auto-plans.json` — auto plan templates

**Local dev** (default when `/data/db.json` missing):

- `data/local-dashboard-db.json`
- `data/tasks.json`
- `data/marco-tasks.json`
- `data/auto-plans.json`

Sibling rule: `tasks.json` and `auto-plans.json` live in the **same directory** as `db.json` unless overridden by env.

Persistence model: **JSON files**, whole-file read/write. No SQLite for tasks. In-memory maps in `db.ts` are flushed to `db.json` on mutations.

---

## 1. Command tasks (`CommandTask`)

**Who uses it:** Carlos command center — column-based kanban (urgent / today / tomorrow / this_week / this_month).

**Stored in:** `db.json` under top-level key `commandTasks` (array).

**Types:** `src/core/types.ts` → `CommandTask`, `CommandTaskColumn`, `CommandTaskStatus`, `CommandTaskColor`.

**Shape:**

```ts
{
  id: string;              // UUID
  title: string;           // required
  description?: string;
  column: "urgent" | "today" | "tomorrow" | "this_week" | "this_month";
  status: "pending" | "done";
  color: "red" | "amber" | "green" | "blue" | "purple" | "gray";
  recurring?: boolean;
  recurringInterval?: "daily" | "every_3_days" | "every_5_days" | "weekly" | "monthly";
  createdBy?: string;      // e.g. "carlos"
  assignedTo?: string;     // default "carlos" on create
  dueDate?: string;        // YYYY-MM-DD
  completedAt?: string;    // ISO
  createdAt: string;
  updatedAt: string;
  tags?: string[];
}
```

**API** (no `DASHBOARD_TOKEN` required on these routes):

- `GET /api/tasks` — query: `column`, `status`, `assignedTo`
- `POST /api/tasks` — requires `title`, `column`
- `PATCH /api/tasks/:id`
- `DELETE /api/tasks/:id`

**Code:** `createCommandTask`, `updateCommandTask`, `deleteCommandTask`, `getCommandTasks` in `src/core/db.ts`. Seeds demo tasks on first load via `seedCommandTasksIfEmpty()`.

**UI:** `public/tasks.html` at route `/tasks`.

---

## 2. CRM follow-up tasks (`Task`)

**Who uses it:** CRM lead follow-up board (calls, texts, appointments tied to leads).

**Stored in:** separate file `tasks.json` — **not** inside `db.json`.

**Types:** `src/core/types.ts` → `Task`, `TaskPriority`, `TaskStatus`, `TaskType`, `TaskSource`.

**Shape:**

```ts
{
  id: string;              // task_<base36>_<random>
  title: string;           // required
  description?: string;
  type: "call" | "text" | "email" | "appointment" | "follow_up" | "other";
  priority: "low" | "normal" | "high" | "urgent";
  status: "pending" | "in_progress" | "completed" | "cancelled";
  dueDate: string;         // YYYY-MM-DD — required
  dueTime?: string;
  leadId?: string;         // links to lead in db.json
  leadName?: string;
  assignedUserId?: string;
  assignedUserName?: string;
  completedAt?: string;
  completedBy?: string;
  createdAt: string;
  updatedAt: string;
  source: "manual" | "auto_plan" | "dial_session" | "automation";
  reminderMinutes?: number;
}
```

**API** (requires `DASHBOARD_TOKEN` or `?token=` when token is set):

- `GET /api/crm-tasks` — filters: `status`, `assignedUserId`, `leadId`, `dueDate`
- `POST /api/crm-tasks`
- `PATCH /api/crm-tasks/:id`
- `DELETE /api/crm-tasks/:id` — gated by `canDeleteTasks` permission when `userId` provided
- `POST /api/crm-tasks/:id/complete`

**Code:** `src/core/tasks.ts` — `getTasks`, `createTask`, `updateTask`, `filterTasks`, `buildTasksSummary`.

**UI:** Embedded in `public/dashboard.html` via `public/crm-followup-tasks.js`.

**Auto-plan integration:** When `executeDueAutoPlanSteps()` runs a step with `type: "task"`, it calls `createTask()` with `source: "auto_plan"` and links `leadId` / `leadName`.

---

## 3. Marco operational tasks (`MarcoTask`)

**Who uses it:** Marco's personal/ops task list (buy camera, review budget, etc.) — **not** lead follow-ups.

**Stored in:** `marco-tasks.json` at `/data/marco-tasks.json` or `data/marco-tasks.json`.

**Types:** `src/core/types.ts` → `MarcoTask`, `MarcoTaskPriority`, `MarcoTaskStatus`.

**Shape:**

```ts
{
  id: string;              // UUID
  title: string;           // required
  description?: string;
  dueDate?: string;        // YYYY-MM-DD — optional
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "done";
  createdBy?: string;      // e.g. "carlos"
  createdAt: string;
  updatedAt: string;
  completedAt?: string;    // set when status → done
}
```

**API** (requires dashboard token):

- `GET /api/marco-tasks` — returns `{ tasks, summary }`
- `POST /api/marco-tasks`
- `PATCH /api/marco-tasks/:id`
- `DELETE /api/marco-tasks/:id`
- `POST /api/marco-tasks/:id/complete`

**Code:** `src/core/marcoTasks.ts`. Seeds 3 demo tasks on first empty load via `seedMarcoTasksIfEmpty()`.

**UI:** Marco Tasks section inside `public/dashboard.html` (not `/tasks`).

---

## 4. Auto plans + enrollments

### Plan templates (`AutoPlan`)

**Stored in:** `auto-plans.json`.

**Shape:**

```ts
{
  id: string;
  name: string;
  tag: string;             // e.g. "Watch", "Nurture", "Active Buyer"
  steps: AutoPlanStep[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// AutoPlanStep
{
  id: string;
  type: "email" | "text" | "task";
  dayOffset: number;       // days after enrollment start
  subject?: string;        // email only
  content: string;
  assignedTo?: string;     // task steps — default "Marco Puga"
}
```

**API:** `/api/auto-plans`, `/api/auto-plans/:id`, enroll/unenroll/pause/resume/skip-step, `POST /api/auto-plans/execute-due-steps`.

**Code:** `src/core/autoPlans.ts`. Seeds 4 default plans on first run.

### Per-lead enrollment (`LeadAutoPlanEnrollment`)

**Stored in:** each `Lead` inside `db.json` → `leadsById[leadId].autoPlanEnrollments[]`.

**Shape:**

```ts
{
  planId: string;
  planName: string;
  enrolledAt: string;      // ISO — anchor for dayOffset math
  currentStepIndex: number;
  completedSteps: string[]; // step IDs executed
  status: "active" | "paused" | "completed";
}
```

When a due **task** step fires, a new row is appended to **`tasks.json`** (CRM follow-up tasks), not to command or marco task files.

---

## Main CRM blob (`db.json`)

Top-level persisted shape (`src/core/db.ts`):

```ts
{
  idCounter: number;
  leadsById: Record<string, Lead>;
  leadKeyToId: Record<string, string>;  // "platform:userId" → leadId
  conversationsByLeadId: Record<string, Conversation>;
  commandTasks?: CommandTask[];
}
```

Leads carry `autoPlanEnrollments`, `activity`, CRM fields, etc. Lead tasks in the CRM UI are stored separately in `tasks.json` but reference `leadId`.

---

## Auth & permissions

- **Command tasks** (`/api/tasks`): open when `DASHBOARD_TOKEN` unset; no bearer required in typical local dev.
- **CRM / Marco tasks**: `dashboardTokenOk()` — `DASHBOARD_TOKEN` env, `?token=`, or `Authorization: Bearer`.
- **Task delete** on CRM tasks: `taskUserCanDelete()` checks CRM user `permissions.canDeleteTasks` (Marco yes, Carlos no by default in `src/core/types.ts` user presets).

---

## Dashboard aggregates

`GET /api/dashboard` (and related summary builders) expose:

- `tasksSummary` — from `tasks.json` (`buildTasksSummary`)
- `commandTasksSummary` — from `commandTasks` in db
- `marcoTasksSummary` — from `marco-tasks.json`

These are independent counts.

---

## Harvey / OpenClaw note

Harvey hull memory (`src/hull/memory/`) is **SQLite** on `/data/harvey-memory.db` — **separate** from task JSON stores. WhatsApp/OpenClaw integration does not read task files unless a tool or route is added to do so.

---

## Quick mental model

```
db.json
├── leadsById.*.autoPlanEnrollments   ← drip state per lead
└── commandTasks[]                    ← /tasks kanban (Carlos)

tasks.json                            ← CRM follow-up tasks (lead-linked)
marco-tasks.json                      ← Marco ops to-dos (dashboard panel)
auto-plans.json                       ← drip templates; task steps → tasks.json
```

When adding features, pick the correct store. Merging stores would break existing UIs and APIs.
