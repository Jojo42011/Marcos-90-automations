"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAutoPlanTriggers = getAutoPlanTriggers;
exports.createAutoPlanTrigger = createAutoPlanTrigger;
exports.updateAutoPlanTrigger = updateAutoPlanTrigger;
exports.deleteAutoPlanTrigger = deleteAutoPlanTrigger;
exports.triggerMatchesLead = triggerMatchesLead;
exports.findTriggeredEnrollment = findTriggeredEnrollment;
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
const fs_1 = require("fs");
const path_1 = require("path");
function resolveTriggersPath() {
    const explicit = process.env.AUTO_PLAN_TRIGGERS_JSON_PATH?.trim();
    if (explicit)
        return explicit;
    const flyDb = "/data/db.json";
    const localDb = (0, path_1.join)(process.cwd(), "data", "local-dashboard-db.json");
    const dbPath = process.env.DB_JSON_PATH?.trim() || ((0, fs_1.existsSync)(flyDb) ? flyDb : localDb);
    return (0, path_1.join)((0, path_1.dirname)(dbPath), "auto-plan-triggers.json");
}
const TRIGGERS_PATH = resolveTriggersPath();
function genId() {
    return `trg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function load() {
    try {
        if (!(0, fs_1.existsSync)(TRIGGERS_PATH))
            return [];
        const parsed = JSON.parse((0, fs_1.readFileSync)(TRIGGERS_PATH, "utf8"));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function save(triggers) {
    (0, fs_1.mkdirSync)((0, path_1.dirname)(TRIGGERS_PATH), { recursive: true });
    (0, fs_1.writeFileSync)(TRIGGERS_PATH, JSON.stringify(triggers, null, 2));
}
function getAutoPlanTriggers() {
    return load();
}
function createAutoPlanTrigger(input) {
    const now = new Date().toISOString();
    const trigger = {
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
function updateAutoPlanTrigger(id, patch) {
    const all = load();
    const idx = all.findIndex((t) => t.id === id);
    if (idx === -1)
        return null;
    const next = { ...all[idx], ...patch, updatedAt: new Date().toISOString() };
    all[idx] = next;
    save(all);
    return next;
}
function deleteAutoPlanTrigger(id) {
    const all = load();
    const next = all.filter((t) => t.id !== id);
    if (next.length === all.length)
        return false;
    save(next);
    return true;
}
function eq(a, b) {
    return String(a).trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}
/** All non-null conditions must hold (Brivity's AND logic); null means Any. */
function triggerMatchesLead(trigger, lead) {
    if (trigger.intent !== null && !eq(trigger.intent, lead.crmIntent))
        return false;
    if (trigger.status !== null && !eq(trigger.status, lead.crmStatus))
        return false;
    if (trigger.source !== null && !eq(trigger.source, lead.source))
        return false;
    if (trigger.tag !== null) {
        const tags = (lead.tags || []).map((t) => t.trim().toLowerCase());
        if (!tags.includes(trigger.tag.trim().toLowerCase()))
            return false;
    }
    return true;
}
/**
 * First matching active trigger whose plan is live, or null.
 * Returns null outright when the lead already has an ACTIVE enrollment —
 * guardrail 2 — so callers cannot forget it. Archived and inactive plans
 * never enroll anyone, whatever their trigger rows say.
 */
function findTriggeredEnrollment(lead, plans) {
    const hasActivePlan = (lead.autoPlanEnrollments || []).some((e) => e.status === "active");
    if (hasActivePlan)
        return null;
    const planById = new Map(plans.map((p) => [p.id, p]));
    for (const trigger of load()) {
        if (!trigger.active)
            continue;
        const plan = planById.get(trigger.planId);
        if (!plan || !plan.active || plan.archived)
            continue;
        if (plan.planType === "transaction")
            continue; // people triggers only
        if (triggerMatchesLead(trigger, lead))
            return { trigger, plan };
    }
    return null;
}
