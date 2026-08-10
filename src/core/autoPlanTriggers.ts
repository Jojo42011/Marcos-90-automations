/**
 * Auto Plan Triggers — the automatic-enrollment layer over the Auto Plans
 * library, modelled on Brivity's "People Auto Plan Triggers" table: each row
 * links a condition to a plan, and a contact is enrolled the moment they match.
 *
 * Two guardrails come straight from Brivity's own behavioral caveats and are
 * enforced by the CALLERS of shouldEnroll (db.ts), not here:
 *
 *   1. Triggers evaluate organic, one-at-a-time changes only — a lead being
 *      created from an inbound DM, or a status/tag/source/intent edit. They
 *      never fire during bulk imports (CSV, Brivity migration, sheet sync),
 *      which write through the *Quiet functions precisely so nothing fans out.
 *   2. A contact already on an active plan is never auto-enrolled in a second
 *      one — stacking plans is a deliberate human decision, not a trigger's.
 *
 * Persists to auto-plan-triggers.json next to the other JSON stores.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import type { AutoPlan, AutoPlanTrigger, Lead } from "./types.js";

function resolveTriggersPath(): string {
  const explicit = process.env.AUTO_PLAN_TRIGGERS_JSON_PATH?.trim();
  if (explicit) return explicit;
  const flyDb = "/data/db.json";
  const localDb = join(process.cwd(), "data", "local-dashboard-db.json");
  const dbPath = process.env.DB_JSON_PATH?.trim() || (existsSync(flyDb) ? flyDb : localDb);
  return join(dirname(dbPath), "auto-plan-triggers.json");
}

const TRIGGERS_PATH = resolveTriggersPath();

function genId(): string {
  return `trg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function load(): AutoPlanTrigger[] {
  try {
    if (!existsSync(TRIGGERS_PATH)) return [];
    const parsed = JSON.parse(readFileSync(TRIGGERS_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as AutoPlanTrigger[]) : [];
  } catch {
    return [];
  }
}

function save(triggers: AutoPlanTrigger[]): void {
  mkdirSync(dirname(TRIGGERS_PATH), { recursive: true });
  writeFileSync(TRIGGERS_PATH, JSON.stringify(triggers, null, 2));
}

export function getAutoPlanTriggers(): AutoPlanTrigger[] {
  return load();
}

export function createAutoPlanTrigger(
  input: Pick<AutoPlanTrigger, "intent" | "status" | "source" | "tag" | "planId"> &
    Partial<Pick<AutoPlanTrigger, "active">>,
): AutoPlanTrigger {
  const now = new Date().toISOString();
  const trigger: AutoPlanTrigger = {
    id: genId(),
    intent: input.intent ?? null,
    status: input.status ?? null,
    source: input.source ?? null,
    tag: input.tag ?? null,
    planId: input.planId,
    active: input.active !== false,
    createdAt: now,
    updatedAt: now,
  };
  const all = load();
  all.push(trigger);
  save(all);
  return trigger;
}

export function updateAutoPlanTrigger(
  id: string,
  patch: Partial<Pick<AutoPlanTrigger, "intent" | "status" | "source" | "tag" | "planId" | "active">>,
): AutoPlanTrigger | null {
  const all = load();
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const next: AutoPlanTrigger = { ...all[idx], ...patch, updatedAt: new Date().toISOString() };
  all[idx] = next;
  save(all);
  return next;
}

export function deleteAutoPlanTrigger(id: string): boolean {
  const all = load();
  const next = all.filter((t) => t.id !== id);
  if (next.length === all.length) return false;
  save(next);
  return true;
}

function eq(a: string | null, b: string | null | undefined): boolean {
  return String(a).trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

/** All non-null conditions must hold (Brivity's AND logic); null means Any. */
export function triggerMatchesLead(trigger: AutoPlanTrigger, lead: Lead): boolean {
  if (trigger.intent !== null && !eq(trigger.intent, lead.crmIntent)) return false;
  if (trigger.status !== null && !eq(trigger.status, lead.crmStatus)) return false;
  if (trigger.source !== null && !eq(trigger.source, lead.source)) return false;
  if (trigger.tag !== null) {
    const tags = (lead.tags || []).map((t) => t.trim().toLowerCase());
    if (!tags.includes(trigger.tag.trim().toLowerCase())) return false;
  }
  return true;
}

/**
 * First matching active trigger whose plan is live, or null.
 * Returns null outright when the lead already has an ACTIVE enrollment —
 * guardrail 2 — so callers cannot forget it. Archived and inactive plans
 * never enroll anyone, whatever their trigger rows say.
 */
export function findTriggeredEnrollment(
  lead: Lead,
  plans: AutoPlan[],
): { trigger: AutoPlanTrigger; plan: AutoPlan } | null {
  const hasActivePlan = (lead.autoPlanEnrollments || []).some((e) => e.status === "active");
  if (hasActivePlan) return null;
  const planById = new Map(plans.map((p) => [p.id, p]));
  for (const trigger of load()) {
    if (!trigger.active) continue;
    const plan = planById.get(trigger.planId);
    if (!plan || !plan.active || plan.archived) continue;
    if (plan.planType === "transaction") continue; // people triggers only
    if (triggerMatchesLead(trigger, lead)) return { trigger, plan };
  }
  return null;
}
