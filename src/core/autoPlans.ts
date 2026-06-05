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
    const dayOffset = typeof s.dayOffset === "number" && s.dayOffset >= 0 ? Math.floor(s.dayOffset) : Number(s.dayOffset) || 0;
    const next: AutoPlanStep = {
      id: typeof s.id === "string" && s.id ? s.id : genId("step"),
      type,
      dayOffset: dayOffset >= 0 ? dayOffset : 0,
      content: typeof s.content === "string" ? s.content : "",
    };
    if (type === "email" && typeof s.subject === "string") next.subject = s.subject;
    if (type === "task") next.assignedTo = typeof s.assignedTo === "string" && s.assignedTo ? s.assignedTo : "Marco Puga";
    out.push(next);
  }
  out.sort((a, b) => a.dayOffset - b.dayOffset);
  return out;
}

export function createAutoPlan(plan: Omit<AutoPlan, "id" | "createdAt" | "updatedAt">): AutoPlan {
  const plans = getAutoPlans();
  const ts = nowIso();
  const created: AutoPlan = {
    id: genId("plan"),
    name: typeof plan.name === "string" && plan.name.trim() ? plan.name.trim() : "Untitled plan",
    tag: typeof plan.tag === "string" ? plan.tag : "",
    steps: normalizeAutoPlanSteps(plan.steps),
    active: plan.active !== false,
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
    steps: updates.steps !== undefined ? normalizeAutoPlanSteps(updates.steps) : cur.steps,
    active: updates.active !== undefined ? Boolean(updates.active) : cur.active,
    updatedAt: nowIso(),
  };
  plans[idx] = next;
  saveAutoPlans(plans);
  return next;
}

export function deleteAutoPlan(id: string): boolean {
  const plans = getAutoPlans();
  const next = plans.filter((p) => p.id !== id);
  if (next.length === plans.length) return false;
  saveAutoPlans(next);
  return true;
}
