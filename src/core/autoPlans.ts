import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import type { AutoPlan, AutoPlanStep } from "./types.js";

/**
 * Auto Plans store — persists to /data/auto-plans.json (Fly volume) or AUTO_PLANS_JSON_PATH.
 * Falls back to the DB volume directory so it lives next to db.json.
 */
function resolveAutoPlansPath(): string {
  const explicit = process.env.AUTO_PLANS_JSON_PATH?.trim();
  if (explicit) return explicit;
  const flyDb = "/data/db.json";
  const localDb = join(process.cwd(), "data", "local-dashboard-db.json");
  const dbPath = process.env.DB_JSON_PATH?.trim() || (existsSync(flyDb) ? flyDb : localDb);
  return join(dirname(dbPath), "auto-plans.json");
}

const AUTO_PLANS_PATH = resolveAutoPlansPath();

function nowIso(): string {
  return new Date().toISOString();
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function step(type: AutoPlanStep["type"], dayOffset: number, content: string, subject?: string, assignedTo?: string): AutoPlanStep {
  const s: AutoPlanStep = { id: genId("step"), type, dayOffset, content };
  if (subject !== undefined) s.subject = subject;
  if (type === "task") s.assignedTo = assignedTo || "Marco Puga";
  return s;
}

/** Build the 4 default seeded plans. */
function buildDefaultPlans(): AutoPlan[] {
  const ts = nowIso();
  const plans: Array<Omit<AutoPlan, "id" | "createdAt" | "updatedAt">> = [
    {
      name: "Watch plan",
      tag: "Watch",
      active: true,
      steps: [
        step("email", 1, "Hi [name], just wanted to reach out and introduce myself...", "Intro email"),
        step("text", 3, "Hey [name], just checking in — any questions about the market?"),
        step("email", 30, "Hi [name], here's what's been happening in your area...", "Market update"),
        step("task", 90, "Follow up call with [name] — check if ready to move forward"),
      ],
    },
    {
      name: "Nurture plan",
      tag: "Nurture",
      active: true,
      steps: [
        step("email", 1, "Hi [name], excited to help you on your real estate journey...", "Welcome email"),
        step("text", 7, "Hey [name], have you had a chance to look at any properties lately?"),
        step("email", 14, "Hi [name], here are some tips for first-time buyers...", "Educational content"),
        step("task", 30, "Schedule consultation call with [name]"),
        step("text", 60, "Hey [name], just thinking of you — still looking to buy?"),
      ],
    },
    {
      name: "Active Buyer plan",
      tag: "Active Buyer",
      active: true,
      steps: [
        step("text", 0, "Hey [name], let's get you set up with some properties that match what you're looking for"),
        step("email", 1, "Hi [name], here are some homes I think you'll love...", "Property matches"),
        step("task", 3, "Call [name] to discuss properties sent"),
        step("text", 7, "Hey [name], did you get a chance to check out those properties?"),
        step("task", 14, "Schedule showing for [name]"),
      ],
    },
    {
      name: "Long-Term plan",
      tag: "Long-Term",
      active: true,
      steps: [
        step("email", 1, "Hi [name], just wanted to keep you in the loop on what's happening...", "Stay in touch"),
        step("email", 30, "Hi [name], here's your monthly real estate update...", "Monthly market update"),
        step("text", 90, "Hey [name], hope all is well — still thinking about making a move?"),
        step("task", 180, "Quarterly check-in call with [name]"),
      ],
    },
  ];
  return plans.map((p) => ({ ...p, id: genId("plan"), createdAt: ts, updatedAt: ts }));
}

function writeAutoPlansFile(plans: AutoPlan[]): void {
  mkdirSync(dirname(AUTO_PLANS_PATH), { recursive: true });
  writeFileSync(AUTO_PLANS_PATH, JSON.stringify(plans, null, 2), "utf8");
}

/** Read all auto plans. Seeds 4 default plans on first run if the file does not exist. */
export function getAutoPlans(): AutoPlan[] {
  try {
    if (!existsSync(AUTO_PLANS_PATH)) {
      const seeded = buildDefaultPlans();
      try {
        writeAutoPlansFile(seeded);
      } catch (err) {
        console.error("[autoPlans] seed write failed:", err);
      }
      return seeded;
    }
    const raw = readFileSync(AUTO_PLANS_PATH, "utf8");
    if (!raw.trim()) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? (data as AutoPlan[]) : [];
  } catch (err) {
    console.error("[autoPlans] getAutoPlans failed:", err);
    return [];
  }
}

export function saveAutoPlans(plans: AutoPlan[]): void {
  try {
    writeAutoPlansFile(plans);
  } catch (err) {
    console.error("[autoPlans] saveAutoPlans failed:", err);
  }
}

export function getAutoPlanById(id: string): AutoPlan | null {
  return getAutoPlans().find((p) => p.id === id) ?? null;
}

/** Normalize a steps payload into AutoPlanStep[] with generated ids where missing. */
export function normalizeAutoPlanSteps(raw: unknown): AutoPlanStep[] {
  if (!Array.isArray(raw)) return [];
  const out: AutoPlanStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const type = s.type === "email" || s.type === "text" || s.type === "task" ? s.type : "text";
    /* Negative offsets are legitimate for transaction plans ("3 days BEFORE
       close date"), so the old >= 0 clamp is gone; enrollment-anchored people
       steps still floor at 0 below via the anchor check. */
    const rawOffset = Number(s.dayOffset);
    const anchor =
      s.anchor === "prev_step" ||
      s.anchor === "contract_date" ||
      s.anchor === "closing_date" ||
      s.anchor === "expiration" ||
      s.anchor === "inspection_date" ||
      s.anchor === "birthday" ||
      s.anchor === "home_anniversary"
        ? s.anchor
        : "enrollment";
    const dateAnchored = anchor !== "enrollment" && anchor !== "prev_step";
    const dayOffset = Number.isFinite(rawOffset)
      ? dateAnchored
        ? Math.trunc(rawOffset)
        : Math.max(0, Math.trunc(rawOffset))
      : 0;
    const next: AutoPlanStep = {
      id: typeof s.id === "string" && s.id ? s.id : genId("step"),
      type,
      dayOffset,
      content: typeof s.content === "string" ? s.content : "",
    };
    /* Unit is stored only when it is not the historical default, so an
       untouched plan round-trips byte-identical. */
    if (s.offsetUnit === "minutes" || s.offsetUnit === "hours") next.offsetUnit = s.offsetUnit;
    if (anchor !== "enrollment") next.anchor = anchor;
    if (anchor === "prev_step" && typeof s.afterStepId === "string" && s.afterStepId) {
      next.afterStepId = s.afterStepId;
    } else if (anchor === "prev_step") {
      next.anchor = "enrollment"; // a chain with no link is just plan-start
    }
    /* Contingent only means something on a chained step: it says "recompute
       from when that step really finished". On any other anchor it would be a
       checkbox that changes nothing, so it is not stored there. */
    if (s.contingent === true && next.anchor === "prev_step") next.contingent = true;
    if (type === "email") {
      if (typeof s.subject === "string") next.subject = s.subject;
      const addrs = (v: unknown): string[] =>
        Array.isArray(v)
          ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
              .map((x) => x.trim().slice(0, 200))
              .slice(0, 10)
          : [];
      const cc = addrs(s.cc);
      const bcc = addrs(s.bcc);
      if (cc.length) next.cc = cc;
      if (bcc.length) next.bcc = bcc;
      if (typeof s.templateId === "string" && s.templateId.trim()) next.templateId = s.templateId.trim();
    }
    /* Brivity has no CC/BCC on SMS — a text is one-to-one from the agent's
       number — so those fields are dropped rather than stored-and-ignored. */
    if (type === "email" || type === "text") {
      if (typeof s.sendFrom === "string" && s.sendFrom.trim()) next.sendFrom = s.sendFrom.trim().slice(0, 60);
    }
    if (type === "task") {
      next.assignedTo = typeof s.assignedTo === "string" && s.assignedTo ? s.assignedTo : "Marco Puga";
      const pr = Number(s.taskPriority);
      if (Number.isInteger(pr) && pr >= 1 && pr <= 9) next.taskPriority = pr;
      if (typeof s.instructions === "string" && s.instructions.trim()) next.instructions = s.instructions.trim();
      if (typeof s.notes === "string" && s.notes.trim()) next.notes = s.notes.trim().slice(0, 2000);
      if (
        s.recurrence === "daily" || s.recurrence === "weekly" ||
        s.recurrence === "monthly" || s.recurrence === "yearly"
      ) {
        next.recurrence = s.recurrence;
      }
    }
    out.push(next);
  }
  /* Keep authoring order — with chained and date-anchored steps a plain
     dayOffset sort would scramble the sequence the builder laid out. */
  return out;
}

export function createAutoPlan(plan: Omit<AutoPlan, "id" | "createdAt" | "updatedAt">): AutoPlan {
  const plans = getAutoPlans();
  const ts = nowIso();
  const created: AutoPlan = {
    id: genId("plan"),
    name: typeof plan.name === "string" && plan.name.trim() ? plan.name.trim() : "Untitled plan",
    tag: typeof plan.tag === "string" ? plan.tag : "",
    planType: plan.planType === "transaction" ? "transaction" : "people",
    steps: normalizeAutoPlanSteps(plan.steps),
    active: plan.active !== false,
    autoPauseOnReply: plan.autoPauseOnReply !== false, // Brivity default: on — the safety valve
    autoPauseOnStatus: typeof plan.autoPauseOnStatus === "string" && plan.autoPauseOnStatus ? plan.autoPauseOnStatus : null,
    completionStatus: typeof plan.completionStatus === "string" && plan.completionStatus ? plan.completionStatus : null,
    archived: plan.archived === true,
    createdAt: ts,
    updatedAt: ts,
  };
  plans.push(created);
  saveAutoPlans(plans);
  return created;
}

export function updateAutoPlan(id: string, updates: Partial<AutoPlan>): AutoPlan | null {
  const plans = getAutoPlans();
  const idx = plans.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const cur = plans[idx];
  const next: AutoPlan = {
    ...cur,
    name: updates.name !== undefined ? String(updates.name).trim() || cur.name : cur.name,
    tag: updates.tag !== undefined ? String(updates.tag) : cur.tag,
    planType: updates.planType !== undefined ? (updates.planType === "transaction" ? "transaction" : "people") : cur.planType,
    steps: updates.steps !== undefined ? normalizeAutoPlanSteps(updates.steps) : cur.steps,
    active: updates.active !== undefined ? Boolean(updates.active) : cur.active,
    autoPauseOnReply: updates.autoPauseOnReply !== undefined ? Boolean(updates.autoPauseOnReply) : cur.autoPauseOnReply,
    autoPauseOnStatus:
      updates.autoPauseOnStatus !== undefined
        ? (typeof updates.autoPauseOnStatus === "string" && updates.autoPauseOnStatus ? updates.autoPauseOnStatus : null)
        : cur.autoPauseOnStatus,
    completionStatus:
      updates.completionStatus !== undefined
        ? (typeof updates.completionStatus === "string" && updates.completionStatus ? updates.completionStatus : null)
        : cur.completionStatus,
    archived: updates.archived !== undefined ? Boolean(updates.archived) : cur.archived,
    updatedAt: nowIso(),
  };
  plans[idx] = next;
  saveAutoPlans(plans);
  return next;
}

/**
 * Clone a plan under a new name with the same steps/settings — Brivity's main
 * path for building a large plan library fast. Step ids are regenerated so the
 * copy's chain references stay internal to the copy.
 */
export function duplicateAutoPlan(id: string): AutoPlan | null {
  const src = getAutoPlanById(id);
  if (!src) return null;
  const idMap = new Map<string, string>();
  const steps = src.steps.map((st) => {
    const nid = genId("step");
    idMap.set(st.id, nid);
    return { ...st, id: nid };
  });
  for (const st of steps) {
    if (st.afterStepId) st.afterStepId = idMap.get(st.afterStepId) ?? st.afterStepId;
  }
  return createAutoPlan({
    ...src,
    name: `${src.name} (copy)`,
    steps,
    archived: false,
  });
}

export function deleteAutoPlan(id: string): boolean {
  const plans = getAutoPlans();
  const next = plans.filter((p) => p.id !== id);
  if (next.length === plans.length) return false;
  saveAutoPlans(next);
  return true;
}
