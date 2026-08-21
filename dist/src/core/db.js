"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.findLeadById = void 0;
exports.normalizeCrmIntent = normalizeCrmIntent;
exports.normalizeCrmTags = normalizeCrmTags;
exports.normalizeCrmStatus = normalizeCrmStatus;
exports.resetMemoryStore = resetMemoryStore;
exports.getCommandTasks = getCommandTasks;
exports.saveCommandTasks = saveCommandTasks;
exports.buildCommandTasksSummary = buildCommandTasksSummary;
exports.seedCommandTasksIfEmpty = seedCommandTasksIfEmpty;
exports.createCommandTask = createCommandTask;
exports.updateCommandTask = updateCommandTask;
exports.deleteCommandTask = deleteCommandTask;
exports.getLead = getLead;
exports.getLeadById = getLeadById;
exports.deleteLead = deleteLead;
exports.deleteLeads = deleteLeads;
exports.phoneMatchKey = phoneMatchKey;
exports.findLeadByPhoneDigits = findLeadByPhoneDigits;
exports.pauseAutoPlansOnInboundText = pauseAutoPlansOnInboundText;
exports.createLead = createLead;
exports.upsertLeadQuiet = upsertLeadQuiet;
exports.updateLead = updateLead;
exports.getConversation = getConversation;
exports.getInboundDmCount = getInboundDmCount;
exports.getLastInboundDmAt = getLastInboundDmAt;
exports.appendMessage = appendMessage;
exports.normalizeCrmDeal = normalizeCrmDeal;
exports.normalizeCrmActivity = normalizeCrmActivity;
exports.normalizeAutoPlanEnrollments = normalizeAutoPlanEnrollments;
exports.normalizeDocuments = normalizeDocuments;
exports.getDashboardSnapshot = getDashboardSnapshot;
exports.listCrmLeads = listCrmLeads;
exports.listAllLeads = listAllLeads;
exports.isLeadInactive30Days = isLeadInactive30Days;
exports.appendLeadActivity = appendLeadActivity;
exports.normalizeRelationships = normalizeRelationships;
exports.normalizeIsoDay = normalizeIsoDay;
exports.updateLeadCrmFields = updateLeadCrmFields;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = require("path");
const messageChannels_js_1 = require("./messageChannels.js");
const types_js_1 = require("./types.js");
const deals_js_1 = require("./deals.js");
const tagTemplates_js_1 = require("./tagTemplates.js");
const users_js_1 = require("./users.js");
const tasks_js_1 = require("./tasks.js");
const marcoTasks_js_1 = require("./marcoTasks.js");
const index_js_1 = require("../integrations/twilio/index.js");
const autoPlans_js_1 = require("./autoPlans.js");
const autoPlanTriggers_js_1 = require("./autoPlanTriggers.js");
const CRM_STATUS_SET = new Set(types_js_1.CRM_STATUSES);
/** Normalize CRM intent; defaults to buyer. */
function normalizeCrmIntent(raw) {
    const s = String(raw ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_");
    if (s === "seller")
        return "seller";
    if (s === "buyer_seller" || s === "buyer+seller" || s === "buyer/seller" || s === "buyer-seller") {
        return "buyer_seller";
    }
    return "buyer";
}
/** Normalize tag list — any non-empty strings; deduped. Legacy status-like labels may remain until cleaned up. */
function normalizeCrmTags(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const t of raw) {
        if (typeof t === "string") {
            const s = t.trim();
            if (s && !out.includes(s))
                out.push(s);
        }
    }
    return out;
}
/** Map legacy / unknown status strings to current CrmStatus without throwing. */
function normalizeCrmStatus(raw) {
    const s = String(raw ?? "")
        .trim()
        .toLowerCase();
    const legacy = {
        not_contacted: "new",
        contacted: "hot",
        warm: "watch",
        cold: "unresponsive",
        nurture: "nurture",
        dead: "dead",
        new: "new",
        hot: "hot",
        watch: "watch",
        unresponsive: "unresponsive",
    };
    if (legacy[s])
        return legacy[s];
    if (CRM_STATUS_SET.has(s))
        return s;
    return "new";
}
/**
 * File-backed store: persists to /data/db.json (Fly volume) or DB_JSON_PATH.
 * Local dev default: ./data/local-dashboard-db.json when the Fly path is missing.
 */
function resolveDbPath() {
    const explicit = process.env.DB_JSON_PATH?.trim();
    if (explicit)
        return explicit;
    const flyDefault = "/data/db.json";
    if ((0, fs_1.existsSync)(flyDefault))
        return flyDefault;
    return (0, path_1.join)(process.cwd(), "data", "local-dashboard-db.json");
}
const DB_PATH = resolveDbPath();
const leadsById = new Map();
const leadKeyToId = new Map(); // platform + userId -> leadId
const conversationsByLeadId = new Map();
let commandTasksStore = [];
let idCounter = 1;
function nowIso() {
    return new Date().toISOString();
}
const COMMAND_COLUMNS = new Set([
    "urgent",
    "today",
    "tomorrow",
    "this_week",
    "this_month",
]);
const COMMAND_COLORS = new Set([
    "red",
    "amber",
    "green",
    "blue",
    "purple",
    "gray",
]);
/**
 * Checklist items must survive the disk round trip. The board saves them fine,
 * but this load-path normalizer predates the checklist/dueTime/reminder/sort
 * fields and silently dropped all four on every restart — and the next
 * persistToFile() then wrote the stripped tasks back, so the loss looked like
 * "checklists vanish when the page refreshes" and was permanent.
 */
function normalizeChecklist(raw) {
    if (!Array.isArray(raw))
        return undefined;
    const items = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== "object")
            continue;
        const e = entry;
        const text = typeof e.text === "string" ? e.text.trim().slice(0, 500) : "";
        if (!text)
            continue;
        items.push({
            id: typeof e.id === "string" && e.id.trim() ? e.id.trim().slice(0, 64) : (0, crypto_1.randomUUID)(),
            text,
            done: e.done === true,
            taskId: typeof e.taskId === "string" && e.taskId.trim() ? e.taskId.trim().slice(0, 64) : undefined,
        });
        if (items.length >= 100)
            break;
    }
    return items.length ? items : undefined;
}
function normalizeCommandTask(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const t = raw;
    const title = typeof t.title === "string" ? t.title.trim() : "";
    if (!title)
        return null;
    const column = COMMAND_COLUMNS.has(t.column)
        ? t.column
        : "today";
    const status = types_js_1.COMMAND_TASK_STATUSES.includes(t.status)
        ? t.status
        : "pending";
    const color = COMMAND_COLORS.has(t.color)
        ? t.color
        : "blue";
    return {
        id: typeof t.id === "string" && t.id ? t.id : (0, crypto_1.randomUUID)(),
        title,
        description: typeof t.description === "string" ? t.description : undefined,
        checklist: normalizeChecklist(t.checklist),
        column,
        status,
        previousStatus: types_js_1.COMMAND_TASK_STATUSES.includes(t.previousStatus)
            ? t.previousStatus
            : undefined,
        color,
        recurring: t.recurring === true,
        recurringInterval: t.recurringInterval === "daily" ||
            t.recurringInterval === "every_3_days" ||
            t.recurringInterval === "every_5_days" ||
            t.recurringInterval === "weekly" ||
            t.recurringInterval === "monthly" ||
            t.recurringInterval === "biweekly"
            ? t.recurringInterval === "biweekly"
                ? "every_3_days"
                : t.recurringInterval
            : undefined,
        createdBy: typeof t.createdBy === "string" ? t.createdBy : undefined,
        assignedTo: typeof t.assignedTo === "string" ? t.assignedTo : undefined,
        dueDate: typeof t.dueDate === "string" ? t.dueDate.slice(0, 10) : undefined,
        dueTime: typeof t.dueTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t.dueTime)
            ? t.dueTime
            : undefined,
        reminderMinutes: Array.isArray(t.reminderMinutes)
            ? t.reminderMinutes
                .map((n) => Math.round(Number(n)))
                .filter((n) => Number.isFinite(n) && n >= 0 && n <= 1440)
            : undefined,
        sortOrder: typeof t.sortOrder === "number" && Number.isFinite(t.sortOrder)
            ? t.sortOrder
            : undefined,
        // Round-tripped deliberately. This normalizer rebuilds every task from a
        // fixed field list on each boot, so a field missing HERE is stripped from
        // disk on the next write — which is exactly how checklists were silently
        // lost for weeks. A content link that vanished on deploy would orphan the
        // task from its card with no way to recover the association.
        contentSlotId: typeof t.contentSlotId === "string" && t.contentSlotId ? t.contentSlotId : undefined,
        completedAt: typeof t.completedAt === "string" ? t.completedAt : undefined,
        createdAt: typeof t.createdAt === "string" ? t.createdAt : nowIso(),
        updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : nowIso(),
        tags: Array.isArray(t.tags)
            ? t.tags.filter((x) => typeof x === "string")
            : undefined,
    };
}
function persistToFile() {
    try {
        (0, fs_1.mkdirSync)((0, path_1.dirname)(DB_PATH), { recursive: true });
        const data = {
            idCounter,
            leadsById: Object.fromEntries(leadsById),
            leadKeyToId: Object.fromEntries(leadKeyToId),
            conversationsByLeadId: Object.fromEntries(conversationsByLeadId),
            commandTasks: commandTasksStore,
        };
        (0, fs_1.writeFileSync)(DB_PATH, JSON.stringify(data), "utf8");
    }
    catch (err) {
        console.error("[db] persistToFile failed:", err);
    }
}
function loadFromFile() {
    try {
        if (!(0, fs_1.existsSync)(DB_PATH)) {
            return;
        }
        const raw = (0, fs_1.readFileSync)(DB_PATH, "utf8");
        if (!raw.trim()) {
            return;
        }
        const data = JSON.parse(raw);
        if (typeof data.idCounter === "number" && data.idCounter >= 1) {
            idCounter = data.idCounter;
        }
        leadsById.clear();
        leadKeyToId.clear();
        conversationsByLeadId.clear();
        commandTasksStore = [];
        if (data.leadsById && typeof data.leadsById === "object") {
            for (const [k, v] of Object.entries(data.leadsById)) {
                if (v && typeof v === "object") {
                    leadsById.set(k, v);
                }
            }
        }
        if (data.leadKeyToId && typeof data.leadKeyToId === "object") {
            for (const [k, v] of Object.entries(data.leadKeyToId)) {
                if (typeof v === "string") {
                    leadKeyToId.set(k, v);
                }
            }
        }
        if (data.conversationsByLeadId && typeof data.conversationsByLeadId === "object") {
            for (const [k, v] of Object.entries(data.conversationsByLeadId)) {
                const conv = v;
                if (conv && typeof conv === "object" && Array.isArray(conv.messages)) {
                    conversationsByLeadId.set(k, conv);
                }
            }
        }
        if (Array.isArray(data.commandTasks)) {
            commandTasksStore = data.commandTasks
                .map(normalizeCommandTask)
                .filter((t) => t !== null);
        }
    }
    catch (err) {
        console.error("[db] loadFromFile failed, starting empty:", err);
    }
}
loadFromFile();
/** Clear all leads and conversations; persists empty state. */
function resetMemoryStore() {
    leadsById.clear();
    leadKeyToId.clear();
    conversationsByLeadId.clear();
    commandTasksStore = [];
    idCounter = 1;
    persistToFile();
}
function getCommandTasks() {
    return [...commandTasksStore];
}
function saveCommandTasks(tasks) {
    commandTasksStore = tasks;
    persistToFile();
}
function buildCommandTasksSummary(tasks) {
    const list = tasks ?? commandTasksStore;
    const active = list.filter((t) => t.status !== "done");
    return {
        urgent: active.filter((t) => t.column === "urgent").length,
        today: active.filter((t) => t.column === "today").length,
        totalPending: active.length,
    };
}
function seedCommandTasksIfEmpty() {
    if (commandTasksStore.length > 0)
        return commandTasksStore;
    const seeds = [
        { title: "Draft weekly email to buyer leads", column: "today", color: "blue", assignedTo: "carlos", recurring: true, recurringInterval: "weekly", createdBy: "carlos" },
        { title: "Add new TikTok leads to Brivity CRM", column: "today", color: "amber", assignedTo: "carlos", createdBy: "carlos" },
        { title: "Confirm tomorrow's consultation appointments", column: "today", color: "green", assignedTo: "carlos", createdBy: "carlos" },
        { title: "Send listing agreement to new seller lead", column: "urgent", color: "red", assignedTo: "carlos", createdBy: "carlos" },
        { title: "Follow up on unsigned buyer rep for Geno Perez", column: "urgent", color: "red", assignedTo: "carlos", createdBy: "carlos" },
        { title: "Weekly check-in on all active transactions", column: "this_week", color: "purple", assignedTo: "carlos", recurring: true, recurringInterval: "weekly", createdBy: "carlos" },
        { title: "Post TikTok videos, 7 per day target", column: "today", color: "blue", assignedTo: "carlos", recurring: true, recurringInterval: "daily", createdBy: "carlos" },
        { title: "Send property options to Canyon Lake inquiry", column: "tomorrow", color: "blue", assignedTo: "carlos", createdBy: "carlos" },
        { title: "Geno Perez, every 3 week check-in re: August closing", column: "this_week", color: "green", assignedTo: "carlos", recurring: true, recurringInterval: "every_3_days", createdBy: "carlos" },
        { title: "Send weekly update to seller leads bucket", column: "this_week", color: "amber", assignedTo: "carlos", recurring: true, recurringInterval: "weekly", createdBy: "carlos" },
    ];
    for (const seed of seeds) {
        createCommandTask({ ...seed, status: "pending" });
    }
    return commandTasksStore;
}
function createCommandTask(data) {
    const task = {
        ...data,
        id: (0, crypto_1.randomUUID)(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
    };
    commandTasksStore.push(task);
    persistToFile();
    return task;
}
function updateCommandTask(id, updates) {
    const idx = commandTasksStore.findIndex((t) => t.id === id);
    if (idx === -1)
        return null;
    commandTasksStore[idx] = {
        ...commandTasksStore[idx],
        ...updates,
        updatedAt: nowIso(),
    };
    if (updates.status === "done" && !commandTasksStore[idx].completedAt) {
        commandTasksStore[idx].completedAt = nowIso();
    }
    persistToFile();
    return commandTasksStore[idx];
}
function deleteCommandTask(id) {
    const filtered = commandTasksStore.filter((t) => t.id !== id);
    if (filtered.length === commandTasksStore.length)
        return false;
    commandTasksStore = filtered;
    persistToFile();
    return true;
}
function leadKey(platform, userId) {
    return `${platform}::${userId}`;
}
async function getLead(platform, userId) {
    const id = leadKeyToId.get(leadKey(platform, userId));
    if (!id)
        return null;
    return leadsById.get(id) ?? null;
}
/** Lookup by internal lead id (CRM / SMS). */
async function getLeadById(leadId) {
    const id = String(leadId || "").trim();
    if (!id)
        return null;
    return leadsById.get(id) ?? null;
}
/** Alias for nurture/scoring modules. */
exports.findLeadById = getLeadById;
/** Permanently remove a lead, its conversation, and platform key mapping. */
function deleteLead(id) {
    const leadId = String(id || "").trim();
    if (!leadId)
        return false;
    const lead = leadsById.get(leadId);
    if (!lead)
        return false;
    leadsById.delete(leadId);
    leadKeyToId.delete(leadKey(lead.platform, lead.userId));
    conversationsByLeadId.delete(leadId);
    return true;
}
/** Delete multiple leads; persists once if any were removed. */
async function deleteLeads(ids) {
    let deleted = 0;
    for (const id of ids) {
        if (deleteLead(id))
            deleted++;
    }
    if (deleted > 0)
        persistToFile();
    return deleted;
}
/** Last 10 digits — matches US numbers with or without +1. */
function phoneMatchKey(phone) {
    if (!phone?.trim())
        return null;
    const d = phone.replace(/\D/g, "");
    if (d.length < 10)
        return null;
    return d.slice(-10);
}
/** First lead whose stored phone matches the given E.164 / local number. */
async function findLeadByPhoneDigits(phone) {
    const key = phoneMatchKey(phone);
    if (!key)
        return null;
    for (const lead of leadsById.values()) {
        if (phoneMatchKey(lead.phone) === key) {
            return lead;
        }
    }
    return null;
}
function leadHasPhone(phone) {
    return Boolean(phone?.trim());
}
function leadHasEmail(email) {
    return Boolean(email?.trim());
}
async function triggerEmailMarketingIfNeeded(lead) {
    if (!leadHasEmail(lead.email))
        return;
    const { onLeadEmailCaptured } = await Promise.resolve().then(() => __importStar(require("../agents/emailMarketing/hooks.js")));
    onLeadEmailCaptured(lead);
}
async function notifyNewPhoneCapture(lead) {
    const marcoNumber = process.env.MARCO_PHONE_NUMBER?.trim();
    const carlosNumber = process.env.CARLOS_PHONE_NUMBER?.trim();
    const message = `📱 New phone captured: ${lead.name || lead.username || "Unknown lead"} ` +
        `(${lead.source || "unknown source"}) — ${lead.phone}. Check CRM Leads tab.`;
    const recipients = [marcoNumber, carlosNumber].filter(Boolean);
    if (recipients.length === 0) {
        console.warn("[PhoneCapture] MARCO_PHONE_NUMBER / CARLOS_PHONE_NUMBER not set — skipping SMS notification");
        return;
    }
    for (const number of recipients) {
        try {
            const result = await (0, index_js_1.sendTwilioMessage)({ to: number, content: message });
            if (!result.success) {
                console.error("[PhoneCapture] Notification failed for", number, ":", result.error);
            }
            else {
                console.log("[PhoneCapture] Notified", number);
            }
        }
        catch (err) {
            console.error("[PhoneCapture] Notification failed for", number, ":", err);
        }
    }
}
function applyPhoneCaptureTransition(existing, lead) {
    const hadBefore = existing ? leadHasPhone(existing.phone) : false;
    const hasNow = leadHasPhone(lead.phone);
    if (!hadBefore && hasNow) {
        const enriched = {
            ...lead,
            phoneCapturedAt: nowIso(),
            phoneNumberSeen: false,
        };
        notifyNewPhoneCapture(enriched).catch((err) => console.error("[PhoneCapture] Notification error:", err));
        return enriched;
    }
    if (!existing) {
        return lead;
    }
    return {
        ...lead,
        phoneCapturedAt: lead.phoneCapturedAt ?? existing.phoneCapturedAt,
        phoneNumberSeen: lead.phoneNumberSeen !== undefined
            ? lead.phoneNumberSeen
            : existing.phoneNumberSeen ?? (existing.phoneCapturedAt ? false : true),
    };
}
function normalizePreApprovalStatus(raw) {
    const s = String(raw ?? "")
        .trim()
        .toLowerCase();
    if (s === "approved" || s === "in_progress" || s === "cash" || s === "not_approved")
        return s;
    return null;
}
async function triggerSourceRoutingIfNeeded(lead) {
    if (lead.sourceRoutingCompletedAt)
        return lead;
    const routedAt = nowIso();
    const marked = { ...lead, sourceRoutingCompletedAt: routedAt };
    leadsById.set(lead.id, marked);
    persistToFile();
    const { routeNewLead } = await Promise.resolve().then(() => __importStar(require("../agents/leadNurture/sourceRouting.js")));
    routeNewLead(marked).catch((err) => console.error("[SourceRouting]", err));
    return marked;
}
/**
 * Auto Plan trigger evaluation + status-change auto-pause. Runs on ORGANIC
 * writes only — createLead (a lead actually arriving) and updateLeadCrmFields
 * when one of the four trigger fields changed. The bulk paths (upsertLeadQuiet,
 * importLeadQuiet) deliberately never call this: Brivity's own triggers skip
 * mass imports, and ours enrolling 500 filed contacts into a texting drip would
 * be far worse than a missed nurture. Mutates and returns `next`.
 */
function applyAutoPlanAutomations(prev, next) {
    try {
        const plans = (0, autoPlans_js_1.getAutoPlans)();
        const planById = new Map(plans.map((p) => [p.id, p]));
        // Auto-pause: the contact's status changed to a value a plan pauses on.
        if (prev && prev.crmStatus !== next.crmStatus && next.autoPlanEnrollments?.length) {
            next.autoPlanEnrollments = next.autoPlanEnrollments.map((enr) => {
                if (enr.status !== "active")
                    return enr;
                const plan = planById.get(enr.planId);
                if (!plan?.autoPauseOnStatus)
                    return enr;
                if (String(plan.autoPauseOnStatus).toLowerCase() !== String(next.crmStatus).toLowerCase())
                    return enr;
                return { ...enr, status: "paused" };
            });
        }
        const relevantChanged = !prev ||
            prev.crmStatus !== next.crmStatus ||
            prev.crmIntent !== next.crmIntent ||
            (prev.source ?? null) !== (next.source ?? null) ||
            JSON.stringify(prev.tags ?? []) !== JSON.stringify(next.tags ?? []);
        if (!relevantChanged)
            return next;
        const hit = (0, autoPlanTriggers_js_1.findTriggeredEnrollment)(next, plans);
        if (hit) {
            next.autoPlanEnrollments = [
                ...(next.autoPlanEnrollments || []).filter((e) => e.planId !== hit.plan.id),
                {
                    planId: hit.plan.id,
                    planName: hit.plan.name,
                    enrolledAt: nowIso(),
                    currentStepIndex: 0,
                    completedSteps: [],
                    enrolledVia: hit.trigger.id,
                    status: "active",
                },
            ];
            next.activity = [
                ...(next.activity || []),
                {
                    type: "auto_plan",
                    description: `Auto-enrolled in "${hit.plan.name}" by trigger`,
                    timestamp: nowIso(),
                },
            ];
        }
    }
    catch (err) {
        // A broken trigger store must never block a lead write.
        console.error("[autoPlans] trigger evaluation failed:", err);
    }
    return next;
}
/** Pause every active enrollment whose plan has the reply safety valve on. */
function pauseAutoPlansOnInboundText(lead) {
    const enrollments = lead.autoPlanEnrollments || [];
    if (!enrollments.some((e) => e.status === "active"))
        return null;
    let plans;
    try {
        plans = (0, autoPlans_js_1.getAutoPlans)();
    }
    catch {
        return null;
    }
    const planById = new Map(plans.map((p) => [p.id, p]));
    let changed = false;
    const next = enrollments.map((enr) => {
        if (enr.status !== "active")
            return enr;
        if (!planById.get(enr.planId)?.autoPauseOnReply)
            return enr;
        changed = true;
        return { ...enr, status: "paused" };
    });
    return changed ? { ...lead, autoPlanEnrollments: next } : null;
}
async function createLead(lead) {
    const id = String(idCounter++);
    const createdAt = nowIso();
    let next = normalizeCrmDefaults({ ...lead, id, createdAt, updatedAt: createdAt });
    next = applyAutoPlanAutomations(null, next);
    if (leadHasPhone(next.phone)) {
        next = {
            ...next,
            phoneCapturedAt: createdAt,
            phoneNumberSeen: false,
        };
        notifyNewPhoneCapture(next).catch((err) => console.error("[PhoneCapture] Notification error:", err));
    }
    leadsById.set(id, next);
    leadKeyToId.set(leadKey(lead.platform, lead.userId), id);
    conversationsByLeadId.set(id, { messages: [] });
    persistToFile();
    const routed = await triggerSourceRoutingIfNeeded(next);
    if (leadHasEmail(routed.email) && !routed.autoReplyEmailSentAt) {
        void triggerEmailMarketingIfNeeded(routed);
    }
    return routed;
}
/**
 * Insert or update a lead with NO outbound side effects.
 *
 * `createLead` deliberately fires automations when a lead arrives: a phone
 * texts Marco and Carlos via Twilio, an email schedules a marketing auto-reply
 * and starts a drip. That is right for a new lead coming out of the DMs, and
 * badly wrong for a bulk import of contacts that already exist elsewhere —
 * filing 500 Brivity contacts through it would send hundreds of texts and email
 * hundreds of cold contacts unprompted.
 *
 * This is the import path: same store, same normalisation, no automations. Use
 * it only for records being filed, never for a lead that has just come in.
 */
function upsertLeadQuiet(input) {
    const now = nowIso();
    const existing = input.id ? leadsById.get(input.id) : undefined;
    if (existing) {
        const merged = normalizeCrmDefaults({ ...existing, ...input, id: existing.id, updatedAt: now });
        leadsById.set(existing.id, merged);
        persistToFile();
        return merged;
    }
    const id = input.id && !leadsById.has(input.id) ? input.id : String(idCounter++);
    const created = normalizeCrmDefaults({ ...input, id, createdAt: now, updatedAt: now });
    leadsById.set(id, created);
    leadKeyToId.set(leadKey(created.platform, created.userId), id);
    if (!conversationsByLeadId.has(id))
        conversationsByLeadId.set(id, { messages: [] });
    persistToFile();
    return created;
}
async function updateLead(lead) {
    const existing = leadsById.get(lead.id);
    if (!existing) {
        let normalized = normalizeCrmDefaults({ ...lead, createdAt: nowIso(), updatedAt: nowIso() });
        normalized = applyPhoneCaptureTransition(null, normalized);
        leadsById.set(lead.id, normalized);
        persistToFile();
        return leadsById.get(lead.id);
    }
    const normalized = normalizeCrmDefaults({ ...lead, updatedAt: nowIso() });
    const updated = applyPhoneCaptureTransition(existing, normalized);
    leadsById.set(lead.id, updated);
    persistToFile();
    const phoneNewlyCaptured = existing && !leadHasPhone(existing.phone) && leadHasPhone(updated.phone);
    if (phoneNewlyCaptured && !updated.sourceRoutingCompletedAt) {
        return await triggerSourceRoutingIfNeeded(updated);
    }
    const emailNewlyCaptured = existing && !leadHasEmail(existing.email) && leadHasEmail(updated.email);
    if (emailNewlyCaptured && !updated.autoReplyEmailSentAt) {
        void triggerEmailMarketingIfNeeded(updated);
    }
    return updated;
}
async function getConversation(leadId) {
    return conversationsByLeadId.get(leadId) ?? { messages: [] };
}
/**
 * How many times this lead has replied over DM.
 *
 * Synchronous on purpose: lead scoring runs this across every lead in one pass
 * and is itself sync. The conversations live in an in-memory Map, so there is
 * nothing to await.
 *
 * A `user` message is a message FROM the lead. This is the DM equivalent of an
 * inbound SMS, and it is the number lead scoring should have been reading all
 * along on a business whose funnel runs on Instagram and TikTok.
 */
function getInboundDmCount(leadId) {
    const conv = conversationsByLeadId.get(leadId);
    if (!conv)
        return 0;
    return conv.messages.reduce((n, m) => (m.role === "user" ? n + 1 : n), 0);
}
/**
 * When this lead last said something to us, or null if they never have.
 *
 * Deliberately the last INBOUND message rather than the last message: five
 * unanswered follow-ups we sent yesterday do not make a lead warm, and using
 * "last touched" would let the system mistake its own activity for interest.
 */
function getLastInboundDmAt(leadId) {
    const conv = conversationsByLeadId.get(leadId);
    if (!conv)
        return null;
    for (let i = conv.messages.length - 1; i >= 0; i--) {
        if (conv.messages[i].role === "user")
            return conv.messages[i].at;
    }
    return null;
}
async function appendMessage(leadId, role, text) {
    const conversation = conversationsByLeadId.get(leadId) ?? { messages: [] };
    conversation.messages.push({ role, text, at: nowIso() });
    conversationsByLeadId.set(leadId, conversation);
    persistToFile();
}
const DEAL_STAGES = new Set(["prospect", "active", "under_contract", "closed"]);
/** Normalize an arbitrary deal payload to a LeadDeal or null. */
function normalizeCrmDeal(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const d = raw;
    const name = typeof d.name === "string" && d.name.trim() ? d.name.trim() : "";
    if (!name)
        return null;
    const stageRaw = typeof d.stage === "string" ? d.stage : "prospect";
    const stage = (DEAL_STAGES.has(stageRaw) ? stageRaw : "prospect");
    const valueNum = d.value === null || d.value === undefined || d.value === "" ? null : Number(d.value);
    return {
        name,
        address: typeof d.address === "string" && d.address.trim() ? d.address.trim() : null,
        value: typeof valueNum === "number" && Number.isFinite(valueNum) ? valueNum : null,
        stage,
        closeDate: typeof d.closeDate === "string" && d.closeDate.trim() ? d.closeDate.trim() : null,
        notes: typeof d.notes === "string" && d.notes.trim() ? d.notes.trim() : null,
    };
}
const ACTIVITY_TYPES = new Set([
    "email_logged",
    "text_logged",
    "appointment",
    "note",
    "other",
    "call",
    "call_made",
    "skip_trace",
    "text_sent",
    "text_received",
    "email_sent",
    "web_visit",
    "home_hearted",
    "home_clicked",
    "re_engagement",
    "listing_off_market",
    "listing_active",
    "task",
    "email_pending",
    "auto_plan",
]);
/** Normalize an arbitrary activity payload to a LeadActivity[] (drops invalid entries). */
function normalizeCrmActivity(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== "object")
            continue;
        const a = item;
        const type = typeof a.type === "string" && ACTIVITY_TYPES.has(a.type) ? a.type : null;
        if (!type)
            continue;
        const entry = {
            type,
            description: typeof a.description === "string" ? a.description : "",
            timestamp: typeof a.timestamp === "string" && a.timestamp ? a.timestamp : nowIso(),
        };
        if (typeof a.notes === "string" && a.notes.trim())
            entry.notes = a.notes.trim();
        if (typeof a.subType === "string" && a.subType.trim())
            entry.subType = a.subType.trim().slice(0, 60);
        if (typeof a.author === "string" && a.author.trim())
            entry.author = a.author.trim().slice(0, 120);
        /* `meta` MUST be round-tripped here. This function rebuilds every activity
           entry from a fixed field list on each write, so a key it does not know
           about is destroyed — the same way normalizeCommandTask silently stripped
           task checklists until one write made the loss permanent (FORAI,
           2026-08-09). Flat scalars only, and capped, because this is display
           detail on a card and not a place to smuggle state. */
        if (a.meta && typeof a.meta === "object" && !Array.isArray(a.meta)) {
            const src = a.meta;
            const meta = {};
            for (const key of Object.keys(src)) {
                if (Object.keys(meta).length >= 16)
                    break;
                const k = key.trim().slice(0, 40);
                if (!k)
                    continue;
                const v = src[key];
                if (v === null)
                    meta[k] = null;
                else if (typeof v === "string")
                    meta[k] = v.slice(0, 600);
                else if (typeof v === "number" && Number.isFinite(v))
                    meta[k] = v;
                else if (typeof v === "boolean")
                    meta[k] = v;
            }
            if (Object.keys(meta).length)
                entry.meta = meta;
        }
        out.push(entry);
    }
    return out;
}
function normalizeSkipTraceResults(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== "object")
            continue;
        const r = item;
        const runAt = typeof r.runAt === "string" && r.runAt ? r.runAt : nowIso();
        const source = typeof r.source === "string" ? r.source : "manual";
        const confidence = r.confidence === "high" || r.confidence === "medium" || r.confidence === "low" ? r.confidence : undefined;
        const ownership = [];
        if (Array.isArray(r.propertyOwnership)) {
            for (const p of r.propertyOwnership) {
                if (!p || typeof p !== "object")
                    continue;
                const po = p;
                const address = typeof po.address === "string" ? po.address : "";
                const owner = typeof po.owner === "string" ? po.owner : "";
                if (!address)
                    continue;
                ownership.push({
                    address,
                    owner,
                    estimatedValue: typeof po.estimatedValue === "number" ? po.estimatedValue : undefined,
                    lastSaleDate: typeof po.lastSaleDate === "string" ? po.lastSaleDate : undefined,
                    lastSalePrice: typeof po.lastSalePrice === "number" ? po.lastSalePrice : undefined,
                });
            }
        }
        const phones = [];
        if (Array.isArray(r.additionalPhones)) {
            for (const ph of r.additionalPhones) {
                if (typeof ph === "string" && ph.trim())
                    phones.push(ph.trim());
            }
        }
        out.push({
            runAt,
            source,
            foundName: typeof r.foundName === "string" ? r.foundName : undefined,
            foundEmail: typeof r.foundEmail === "string" ? r.foundEmail : undefined,
            foundAddress: typeof r.foundAddress === "string" ? r.foundAddress : undefined,
            propertyOwnership: ownership.length ? ownership : undefined,
            additionalPhones: phones.length ? phones : undefined,
            confidence,
            raw: r.raw,
        });
    }
    return out;
}
/** Normalize an arbitrary payload to LeadAutoPlanEnrollment[] (drops invalid entries). */
function normalizeAutoPlanEnrollments(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== "object")
            continue;
        const e = item;
        const planId = typeof e.planId === "string" ? e.planId : "";
        if (!planId)
            continue;
        const status = e.status === "paused" || e.status === "completed" ? e.status : "active";
        const entry = {
            planId,
            planName: typeof e.planName === "string" ? e.planName : "",
            enrolledAt: typeof e.enrolledAt === "string" && e.enrolledAt ? e.enrolledAt : nowIso(),
            currentStepIndex: typeof e.currentStepIndex === "number" && e.currentStepIndex >= 0 ? e.currentStepIndex : 0,
            completedSteps: Array.isArray(e.completedSteps)
                ? e.completedSteps.filter((s) => typeof s === "string")
                : [],
            status,
        };
        /* completedAt drives step chaining; enrolledVia drives trigger enrolled
           counts. Dropping either here would silently break both features. */
        if (e.completedAt && typeof e.completedAt === "object" && !Array.isArray(e.completedAt)) {
            const map = {};
            for (const [k, v] of Object.entries(e.completedAt)) {
                if (typeof v === "string")
                    map[k] = v;
            }
            entry.completedAt = map;
        }
        /* lastRunAt/runCount are the recurring-step clock. Same reasoning as
           completedAt above: a repeating step is never "completed", so dropping
           these here would make it re-fire on every single engine tick. */
        if (e.lastRunAt && typeof e.lastRunAt === "object" && !Array.isArray(e.lastRunAt)) {
            const map = {};
            for (const [k, v] of Object.entries(e.lastRunAt)) {
                if (typeof v === "string")
                    map[k] = v;
            }
            if (Object.keys(map).length)
                entry.lastRunAt = map;
        }
        if (e.runCount && typeof e.runCount === "object" && !Array.isArray(e.runCount)) {
            const map = {};
            for (const [k, v] of Object.entries(e.runCount)) {
                const n = Number(v);
                if (Number.isFinite(n) && n >= 0)
                    map[k] = Math.trunc(n);
            }
            if (Object.keys(map).length)
                entry.runCount = map;
        }
        if (typeof e.enrolledVia === "string" && e.enrolledVia)
            entry.enrolledVia = e.enrolledVia;
        out.push(entry);
    }
    return out;
}
const DOC_STATUSES = new Set(["pending", "sent", "signed", "declined"]);
/** Normalize an arbitrary payload to SigningDocument[] (drops invalid entries). */
function normalizeDocuments(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== "object")
            continue;
        const d = item;
        const id = typeof d.id === "string" ? d.id : "";
        if (!id)
            continue;
        const status = typeof d.status === "string" && DOC_STATUSES.has(d.status)
            ? d.status
            : "pending";
        const doc = {
            id,
            name: typeof d.name === "string" ? d.name : "Document",
            fileData: typeof d.fileData === "string" ? d.fileData : "",
            status,
        };
        if (typeof d.sentAt === "string")
            doc.sentAt = d.sentAt;
        if (typeof d.signedAt === "string")
            doc.signedAt = d.signedAt;
        if (typeof d.signerEmail === "string")
            doc.signerEmail = d.signerEmail;
        if (typeof d.signerName === "string")
            doc.signerName = d.signerName;
        out.push(doc);
    }
    return out;
}
function normalizeShowingAppointment(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const a = raw;
    const address = typeof a.address === "string" ? a.address.trim() : "";
    const scheduledAt = typeof a.scheduledAt === "string" ? a.scheduledAt.trim() : "";
    if (!address || !scheduledAt)
        return null;
    const statusRaw = typeof a.confirmationStatus === "string" ? a.confirmationStatus.trim().toLowerCase() : "pending";
    const confirmationStatus = statusRaw === "confirmed" ||
        statusRaw === "no_response" ||
        statusRaw === "cancelled" ||
        statusRaw === "pending"
        ? statusRaw
        : "pending";
    const out = {
        address,
        scheduledAt,
        confirmationStatus,
    };
    if (typeof a.reminderSentAt === "string" && a.reminderSentAt)
        out.reminderSentAt = a.reminderSentAt;
    if (typeof a.confirmationReceivedAt === "string" && a.confirmationReceivedAt) {
        out.confirmationReceivedAt = a.confirmationReceivedAt;
    }
    if (typeof a.followUpSentAt === "string" && a.followUpSentAt)
        out.followUpSentAt = a.followUpSentAt;
    if (typeof a.followUpResponse === "string" && a.followUpResponse)
        out.followUpResponse = a.followUpResponse;
    const sentimentRaw = typeof a.followUpSentiment === "string" ? a.followUpSentiment.trim().toLowerCase() : "";
    if (sentimentRaw === "positive" || sentimentRaw === "negative" || sentimentRaw === "neutral") {
        out.followUpSentiment = sentimentRaw;
    }
    return out;
}
function normalizeMojoOutreach(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const m = raw;
    const statusRaw = typeof m.status === "string" ? m.status.trim().toLowerCase() : "active";
    const status = statusRaw === "paused" || statusRaw === "replied" || statusRaw === "completed" || statusRaw === "active"
        ? statusRaw
        : "active";
    const textsSent = typeof m.textsSent === "number" && Number.isFinite(m.textsSent)
        ? Math.max(0, Math.min(2, Math.floor(m.textsSent)))
        : 0;
    const out = {
        sequenceStarted: m.sequenceStarted === true,
        textsSent,
        status,
    };
    if (typeof m.lastTextSentAt === "string" && m.lastTextSentAt)
        out.lastTextSentAt = m.lastTextSentAt;
    if (typeof m.pausedUntil === "string" && m.pausedUntil)
        out.pausedUntil = m.pausedUntil;
    return out;
}
function normalizeAutomationPausedReason(raw) {
    const s = String(raw ?? "")
        .trim()
        .toLowerCase();
    if (s === "ready_to_offer" || s === "angry_client" || s === "legal_question")
        return s;
    return null;
}
function normalizeCrmDefaults(lead) {
    const crmStatus = normalizeCrmStatus(lead.crmStatus);
    const crmStage = lead.crmStage ?? "new";
    const crmPriority = lead.crmPriority ?? "normal";
    const crmNotes = lead.crmNotes ?? null;
    const crmIntent = normalizeCrmIntent(lead.crmIntent);
    const rawQ = lead.crmCallQueue;
    const crmCallQueue = rawQ === "urgent" || rawQ === "routine" ? rawQ : "none";
    const adCampaign = lead.adCampaign ?? null;
    const tags = normalizeCrmTags(lead.tags);
    const prevTags = normalizeCrmTags(lead.tags);
    const tagsSame = prevTags.length === tags.length && prevTags.every((t, i) => t === tags[i]);
    const rawAlerts = lead.alerts;
    const alerts = typeof rawAlerts === "number" && rawAlerts > 0 ? rawAlerts : 0;
    const rawReports = lead.reports;
    const reports = typeof rawReports === "number" && rawReports > 0 ? rawReports : 0;
    const deal = normalizeCrmDeal(lead.deal);
    const activity = normalizeCrmActivity(lead.activity);
    const rawLast = lead.lastActivity;
    const lastActivity = typeof rawLast === "string" && rawLast ? rawLast : null;
    const rawListing = lead.listingStatus;
    const listingStatus = rawListing === "active" || rawListing === "off_market" ? rawListing : null;
    const autoPlanEnrollments = normalizeAutoPlanEnrollments(lead.autoPlanEnrollments);
    const documents = normalizeDocuments(lead.documents);
    const skipTraceResults = normalizeSkipTraceResults(lead.skipTraceResults);
    const rawAssignId = lead.assignedUserId;
    const assignedUserId = typeof rawAssignId === "string" && rawAssignId.trim() ? rawAssignId.trim() : null;
    const rawAssignName = lead.assignedUserName;
    const assignedUserName = typeof rawAssignName === "string" && rawAssignName.trim() ? rawAssignName.trim() : null;
    const dealSame = JSON.stringify(lead.deal ?? null) === JSON.stringify(deal);
    const activitySame = JSON.stringify(lead.activity ?? []) === JSON.stringify(activity);
    const enrollmentsSame = JSON.stringify(lead.autoPlanEnrollments ?? []) === JSON.stringify(autoPlanEnrollments);
    const documentsSame = JSON.stringify(lead.documents ?? []) === JSON.stringify(documents);
    const skipSame = JSON.stringify(lead.skipTraceResults ?? []) === JSON.stringify(skipTraceResults);
    const showingAppointment = normalizeShowingAppointment(lead.showingAppointment);
    const prevShowing = normalizeShowingAppointment(lead.showingAppointment);
    const showingSame = JSON.stringify(prevShowing) === JSON.stringify(showingAppointment);
    const mojoOutreach = normalizeMojoOutreach(lead.mojoOutreach);
    const prevMojo = normalizeMojoOutreach(lead.mojoOutreach);
    const mojoSame = JSON.stringify(prevMojo) === JSON.stringify(mojoOutreach);
    const automationPaused = lead.automationPaused === true;
    const automationPausedReason = normalizeAutomationPausedReason(lead.automationPausedReason);
    const rawPausedAt = lead.automationPausedAt;
    const automationPausedAt = typeof rawPausedAt === "string" && rawPausedAt ? rawPausedAt : null;
    const preApprovalStatus = normalizePreApprovalStatus(lead.preApprovalStatus);
    const rawViews = lead.propertyViewsCount;
    const propertyViewsCount = typeof rawViews === "number" && Number.isFinite(rawViews) && rawViews > 0 ? Math.floor(rawViews) : 0;
    const rawRoutingAt = lead.sourceRoutingCompletedAt;
    const sourceRoutingCompletedAt = typeof rawRoutingAt === "string" && rawRoutingAt ? rawRoutingAt : null;
    if (lead.crmStatus === crmStatus &&
        lead.crmStage === crmStage &&
        lead.crmPriority === crmPriority &&
        lead.crmNotes === crmNotes &&
        lead.crmIntent === crmIntent &&
        lead.crmCallQueue === crmCallQueue &&
        lead.adCampaign === adCampaign &&
        lead.alerts === alerts &&
        lead.reports === reports &&
        (lead.lastActivity ?? null) === lastActivity &&
        (lead.listingStatus ?? null) === listingStatus &&
        tagsSame &&
        dealSame &&
        activitySame &&
        enrollmentsSame &&
        documentsSame &&
        skipSame &&
        showingSame &&
        mojoSame &&
        lead.automationPaused === automationPaused &&
        (lead.automationPausedReason ?? null) === automationPausedReason &&
        (lead.automationPausedAt ?? null) === automationPausedAt &&
        (lead.assignedUserId ?? null) === assignedUserId &&
        (lead.assignedUserName ?? null) === assignedUserName &&
        (lead.preApprovalStatus ?? null) === preApprovalStatus &&
        (lead.propertyViewsCount ?? 0) === propertyViewsCount &&
        (lead.sourceRoutingCompletedAt ?? null) === sourceRoutingCompletedAt) {
        return lead;
    }
    const phoneCapturedAt = typeof lead.phoneCapturedAt === "string"
        ? lead.phoneCapturedAt
        : undefined;
    const rawSeen = lead.phoneNumberSeen;
    const phoneNumberSeen = rawSeen === false ? false : rawSeen === true ? true : undefined;
    return {
        ...lead,
        crmStatus,
        crmStage,
        crmPriority,
        crmNotes,
        crmIntent,
        crmCallQueue,
        adCampaign,
        tags,
        alerts,
        reports,
        deal,
        activity,
        lastActivity,
        listingStatus,
        autoPlanEnrollments,
        documents,
        skipTraceResults,
        assignedUserId,
        assignedUserName,
        phoneCapturedAt,
        phoneNumberSeen,
        showingAppointment,
        mojoOutreach,
        automationPaused,
        automationPausedReason,
        automationPausedAt,
        preApprovalStatus,
        propertyViewsCount,
        sourceRoutingCompletedAt,
    };
}
/**
 * Snapshot of all leads + message counts for dashboard UI (read-only).
 * For the DM Agent table, we only SHOW leads that have a phone number on file.
 */
async function getDashboardSnapshot() {
    const generatedAt = nowIso();
    const leads = [];
    const byPlatform = {};
    const byAdCampaign = {};
    const byAdCampaignWithPhone = {};
    let withPhone = 0;
    let withEmail = 0;
    let totalUserMessages = 0;
    let totalAssistantMessages = 0;
    for (const raw of leadsById.values()) {
        const lead = normalizeCrmDefaults(raw);
        const conv = conversationsByLeadId.get(lead.id) ?? { messages: [] };
        const msgs = conv.messages;
        let userMessageCount = 0;
        let assistantMessageCount = 0;
        let lastMessageAt = null;
        for (const m of msgs) {
            if (m.role === "user")
                userMessageCount++;
            else
                assistantMessageCount++;
            if (m.at && (!lastMessageAt || m.at > lastMessageAt))
                lastMessageAt = m.at;
        }
        totalUserMessages += userMessageCount;
        totalAssistantMessages += assistantMessageCount;
        const hasPhone = Boolean(lead.phone?.trim());
        const hasEmail = Boolean(lead.email?.trim());
        if (hasPhone)
            withPhone++;
        if (hasEmail)
            withEmail++;
        const plat = lead.platform || "unknown";
        byPlatform[plat] = (byPlatform[plat] ?? 0) + 1;
        if (lead.adCampaign) {
            byAdCampaign[lead.adCampaign] = (byAdCampaign[lead.adCampaign] ?? 0) + 1;
            if (hasPhone) {
                byAdCampaignWithPhone[lead.adCampaign] = (byAdCampaignWithPhone[lead.adCampaign] ?? 0) + 1;
            }
        }
        if (!hasPhone)
            continue;
        leads.push({
            id: lead.id,
            platform: lead.platform,
            channel: (0, messageChannels_js_1.channelForLead)(lead),
            userId: lead.userId,
            username: lead.username,
            name: lead.name,
            phone: lead.phone,
            email: lead.email,
            state: String(lead.state),
            source: lead.source,
            adCampaign: lead.adCampaign,
            propertyInquired: lead.propertyInquired,
            criteria: lead.criteria,
            brivityId: lead.brivityId,
            crmStatus: lead.crmStatus,
            crmStage: lead.crmStage,
            crmPriority: lead.crmPriority,
            crmIntent: lead.crmIntent,
            crmCallQueue: lead.crmCallQueue,
            crmNotes: lead.crmNotes,
            tags: normalizeCrmTags(lead.tags),
            address: typeof lead.address === "string" && lead.address.trim() ? lead.address.trim() : null,
            birthday: normalizeIsoDay(lead.birthday),
            homeAnniversary: normalizeIsoDay(lead.homeAnniversary),
            description: typeof lead.description === "string" && lead.description.trim() ? lead.description : null,
            letterSalutation: typeof lead.letterSalutation === "string" && lead.letterSalutation.trim() ? lead.letterSalutation.trim() : null,
            envelopeSalutation: typeof lead.envelopeSalutation === "string" && lead.envelopeSalutation.trim() ? lead.envelopeSalutation.trim() : null,
            preferredLanguage: typeof lead.preferredLanguage === "string" && lead.preferredLanguage.trim() ? lead.preferredLanguage.trim() : null,
            relationships: normalizeRelationships(lead.relationships),
            alerts: typeof lead.alerts === "number" && lead.alerts > 0 ? lead.alerts : 0,
            reports: typeof lead.reports === "number" && lead.reports > 0 ? lead.reports : 0,
            createdAt: lead.createdAt,
            updatedAt: lead.updatedAt,
            userMessageCount,
            assistantMessageCount,
            totalMessages: msgs.length,
            lastMessageAt,
            messages: msgs,
            activity: normalizeCrmActivity(lead.activity),
            deal: normalizeCrmDeal(lead.deal),
            lastActivity: typeof lead.lastActivity === "string" && lead.lastActivity ? lead.lastActivity : null,
            listingStatus: lead.listingStatus === "active" || lead.listingStatus === "off_market" ? lead.listingStatus : null,
            autoPlanEnrollments: normalizeAutoPlanEnrollments(lead.autoPlanEnrollments),
            documents: normalizeDocuments(lead.documents),
            assignedUserId: lead.assignedUserId ?? null,
            assignedUserName: lead.assignedUserName ?? null,
            skipTraceResults: normalizeSkipTraceResults(lead.skipTraceResults),
            phoneCapturedAt: lead.phoneCapturedAt ?? undefined,
            phoneNumberSeen: lead.phoneNumberSeen ?? (lead.phoneCapturedAt ? false : true),
        });
    }
    leads.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    const deals = (0, deals_js_1.getDeals)();
    const totalGCI = (0, deals_js_1.sumClosedDealGCI)(deals);
    const tasksSummary = (0, tasks_js_1.buildTasksSummary)();
    const commandTasksSummary = buildCommandTasksSummary();
    const marcoTasksSummary = (0, marcoTasks_js_1.buildMarcoTasksSummary)((0, marcoTasks_js_1.getMarcoTasks)());
    return {
        generatedAt,
        totals: {
            leads: leadsById.size,
            withPhone,
            withEmail,
            shownLeads: leads.length,
            totalUserMessages,
            totalAssistantMessages,
            totalMessages: totalUserMessages + totalAssistantMessages,
        },
        byPlatform,
        byAdCampaign,
        byAdCampaignWithPhone,
        leads,
        tagTemplates: (0, tagTemplates_js_1.getTagTemplates)(),
        users: (0, users_js_1.getUsers)(),
        deals,
        totalGCI,
        tasksSummary,
        commandTasksSummary,
        marcoTasksSummary,
    };
}
async function listCrmLeads() {
    const snap = await getDashboardSnapshot();
    return snap.leads;
}
/** All leads in the store (including without phone) — for Harvey ops perception. */
async function listAllLeads() {
    const out = [];
    for (const raw of leadsById.values()) {
        out.push(normalizeCrmDefaults(raw));
    }
    return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
const INACTIVE_MS = 30 * 24 * 60 * 60 * 1000;
/** True if no conversation messages and no activity entries in the last 30 days. */
async function isLeadInactive30Days(leadId) {
    const lead = await getLeadById(leadId);
    if (!lead)
        return false;
    const cutoff = Date.now() - INACTIVE_MS;
    const conv = await getConversation(leadId);
    for (const m of conv.messages) {
        if (m.at && new Date(m.at).getTime() >= cutoff)
            return false;
    }
    const activity = normalizeCrmActivity(lead.activity);
    for (const a of activity) {
        if (a.timestamp && new Date(a.timestamp).getTime() >= cutoff)
            return false;
    }
    if (lead.lastActivity && new Date(lead.lastActivity).getTime() >= cutoff)
        return false;
    return true;
}
/** Append one or more activity entries and optionally bump lastActivity. */
async function appendLeadActivity(leadId, entries, opts) {
    const existing = leadsById.get(leadId);
    if (!existing)
        return null;
    const lead = normalizeCrmDefaults(existing);
    const merged = [...normalizeCrmActivity(lead.activity), ...entries];
    const stamp = opts?.lastActivity ?? nowIso();
    return updateLeadCrmFields({
        leadId,
        activity: merged,
        lastActivity: stamp,
    });
}
/** Relationships: name+relation required, capped, unknown fields dropped. */
function normalizeRelationships(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== "object")
            continue;
        const r = item;
        const name = typeof r.name === "string" ? r.name.trim().slice(0, 120) : "";
        const relation = typeof r.relation === "string" ? r.relation.trim().slice(0, 60) : "";
        if (!name || !relation)
            continue;
        const entry = { name, relation };
        if (typeof r.leadId === "string" && r.leadId.trim())
            entry.leadId = r.leadId.trim();
        out.push(entry);
        if (out.length >= 30)
            break;
    }
    return out;
}
/** A date-only field is either a valid YYYY-MM-DD string or null — junk never sticks. */
function normalizeIsoDay(raw) {
    if (typeof raw !== "string")
        return null;
    const s = raw.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s))
        return null;
    const d = new Date(s + "T00:00:00Z");
    return Number.isNaN(d.getTime()) ? null : s;
}
async function updateLeadCrmFields(input) {
    const existing = leadsById.get(input.leadId);
    if (!existing)
        return null;
    const lead = normalizeCrmDefaults(existing);
    let criteria = lead.criteria;
    if (input.criteria !== undefined) {
        if (input.criteria === null) {
            criteria = null;
        }
        else {
            const base = criteria ?? { priceCap: null, beds: null, baths: null, area: null, timeline: null };
            criteria = {
                priceCap: input.criteria.priceCap !== undefined ? input.criteria.priceCap : base.priceCap,
                beds: input.criteria.beds !== undefined ? input.criteria.beds : base.beds,
                baths: input.criteria.baths !== undefined ? input.criteria.baths : base.baths,
                area: input.criteria.area !== undefined ? input.criteria.area : base.area,
                timeline: input.criteria.timeline !== undefined
                    ? input.criteria.timeline === null
                        ? null
                        : String(input.criteria.timeline)
                    : base.timeline ?? null,
            };
        }
    }
    const next = {
        ...lead,
        mlsListingKey: input.mlsListingKey !== undefined ? input.mlsListingKey : lead.mlsListingKey,
        crmStatus: input.crmStatus !== undefined ? normalizeCrmStatus(input.crmStatus) : lead.crmStatus,
        crmStage: input.crmStage ?? lead.crmStage,
        crmPriority: input.crmPriority ?? lead.crmPriority,
        crmIntent: input.crmIntent !== undefined ? normalizeCrmIntent(input.crmIntent) : normalizeCrmIntent(lead.crmIntent),
        crmCallQueue: input.crmCallQueue ?? lead.crmCallQueue,
        crmNotes: input.crmNotes !== undefined ? input.crmNotes : lead.crmNotes,
        name: input.name !== undefined ? input.name : lead.name,
        email: input.email !== undefined ? input.email : lead.email,
        phone: input.phone !== undefined ? input.phone : lead.phone,
        source: input.source !== undefined ? input.source : lead.source,
        propertyInquired: input.propertyInquired !== undefined ? input.propertyInquired : lead.propertyInquired,
        brivityId: input.brivityId !== undefined ? input.brivityId : lead.brivityId,
        criteria,
        tags: input.tags !== undefined ? normalizeCrmTags(input.tags) : normalizeCrmTags(lead.tags),
        address: input.address !== undefined
            ? input.address === null || !String(input.address).trim()
                ? null
                : String(input.address).trim()
            : lead.address ?? null,
        birthday: input.birthday !== undefined ? normalizeIsoDay(input.birthday) : normalizeIsoDay(lead.birthday),
        description: input.description !== undefined ? (input.description === null || !String(input.description).trim() ? null : String(input.description).slice(0, 4000)) : lead.description ?? null,
        letterSalutation: input.letterSalutation !== undefined ? (input.letterSalutation === null || !String(input.letterSalutation).trim() ? null : String(input.letterSalutation).trim().slice(0, 120)) : lead.letterSalutation ?? null,
        envelopeSalutation: input.envelopeSalutation !== undefined ? (input.envelopeSalutation === null || !String(input.envelopeSalutation).trim() ? null : String(input.envelopeSalutation).trim().slice(0, 120)) : lead.envelopeSalutation ?? null,
        preferredLanguage: input.preferredLanguage !== undefined ? (input.preferredLanguage === null || !String(input.preferredLanguage).trim() ? null : String(input.preferredLanguage).trim().slice(0, 60)) : lead.preferredLanguage ?? null,
        relationships: input.relationships !== undefined ? normalizeRelationships(input.relationships) : normalizeRelationships(lead.relationships),
        homeAnniversary: input.homeAnniversary !== undefined
            ? normalizeIsoDay(input.homeAnniversary)
            : normalizeIsoDay(lead.homeAnniversary),
        deal: input.deal !== undefined ? normalizeCrmDeal(input.deal) : normalizeCrmDeal(lead.deal),
        activity: input.activity !== undefined ? normalizeCrmActivity(input.activity) : normalizeCrmActivity(lead.activity),
        lastActivity: input.lastActivity !== undefined ? input.lastActivity : (lead.lastActivity ?? null),
        listingStatus: input.listingStatus !== undefined
            ? input.listingStatus === "active" || input.listingStatus === "off_market"
                ? input.listingStatus
                : null
            : lead.listingStatus === "active" || lead.listingStatus === "off_market"
                ? lead.listingStatus
                : null,
        alerts: input.alerts !== undefined ? (input.alerts > 0 ? input.alerts : 0) : (typeof lead.alerts === "number" && lead.alerts > 0 ? lead.alerts : 0),
        autoPlanEnrollments: input.autoPlanEnrollments !== undefined
            ? normalizeAutoPlanEnrollments(input.autoPlanEnrollments)
            : normalizeAutoPlanEnrollments(lead.autoPlanEnrollments),
        documents: input.documents !== undefined ? normalizeDocuments(input.documents) : normalizeDocuments(lead.documents),
        skipTraceResults: input.skipTraceResults !== undefined
            ? normalizeSkipTraceResults(input.skipTraceResults)
            : normalizeSkipTraceResults(lead.skipTraceResults),
        assignedUserId: input.assignedUserId !== undefined
            ? input.assignedUserId === null || input.assignedUserId === ""
                ? null
                : String(input.assignedUserId).trim()
            : lead.assignedUserId ?? null,
        assignedUserName: input.assignedUserName !== undefined
            ? input.assignedUserName === null || input.assignedUserName === ""
                ? null
                : String(input.assignedUserName).trim()
            : lead.assignedUserName ?? null,
        phoneNumberSeen: input.phoneNumberSeen !== undefined ? input.phoneNumberSeen : lead.phoneNumberSeen,
        showingAppointment: input.showingAppointment !== undefined
            ? normalizeShowingAppointment(input.showingAppointment)
            : normalizeShowingAppointment(lead.showingAppointment),
        mojoOutreach: input.mojoOutreach !== undefined
            ? normalizeMojoOutreach(input.mojoOutreach)
            : normalizeMojoOutreach(lead.mojoOutreach),
        automationPaused: input.automationPaused !== undefined ? input.automationPaused : lead.automationPaused ?? false,
        automationPausedReason: input.automationPausedReason !== undefined
            ? normalizeAutomationPausedReason(input.automationPausedReason)
            : normalizeAutomationPausedReason(lead.automationPausedReason),
        automationPausedAt: input.automationPausedAt !== undefined
            ? input.automationPausedAt === null || input.automationPausedAt === ""
                ? null
                : String(input.automationPausedAt)
            : lead.automationPausedAt ?? null,
        isPastClient: input.isPastClient !== undefined ? input.isPastClient : lead.isPastClient ?? false,
        pastClientSince: input.pastClientSince !== undefined
            ? input.pastClientSince === null || input.pastClientSince === ""
                ? null
                : String(input.pastClientSince)
            : lead.pastClientSince ?? null,
        preApprovalStatus: input.preApprovalStatus !== undefined
            ? normalizePreApprovalStatus(input.preApprovalStatus)
            : lead.preApprovalStatus ?? null,
        propertyViewsCount: input.propertyViewsCount !== undefined
            ? typeof input.propertyViewsCount === "number" && input.propertyViewsCount > 0
                ? Math.floor(input.propertyViewsCount)
                : 0
            : lead.propertyViewsCount ?? 0,
        sourceRoutingCompletedAt: input.sourceRoutingCompletedAt !== undefined
            ? input.sourceRoutingCompletedAt === null || input.sourceRoutingCompletedAt === ""
                ? null
                : String(input.sourceRoutingCompletedAt)
            : lead.sourceRoutingCompletedAt ?? null,
        autoReplyEmailSentAt: input.autoReplyEmailSentAt !== undefined
            ? input.autoReplyEmailSentAt === null || input.autoReplyEmailSentAt === ""
                ? null
                : String(input.autoReplyEmailSentAt)
            : lead.autoReplyEmailSentAt ?? null,
        movedToColdNurtureAt: input.movedToColdNurtureAt !== undefined
            ? input.movedToColdNurtureAt === null || input.movedToColdNurtureAt === ""
                ? null
                : String(input.movedToColdNurtureAt)
            : lead.movedToColdNurtureAt ?? null,
        lastWebsiteVisitAt: input.lastWebsiteVisitAt !== undefined
            ? input.lastWebsiteVisitAt === null || input.lastWebsiteVisitAt === ""
                ? null
                : String(input.lastWebsiteVisitAt)
            : lead.lastWebsiteVisitAt ?? null,
        lastReEngagementTriggeredAt: input.lastReEngagementTriggeredAt !== undefined
            ? input.lastReEngagementTriggeredAt === null || input.lastReEngagementTriggeredAt === ""
                ? null
                : String(input.lastReEngagementTriggeredAt)
            : lead.lastReEngagementTriggeredAt ?? null,
    };
    /* Trigger evaluation on organic field changes — but never when the caller is
       explicitly managing enrollments (input.autoPlanEnrollments set): unenrolling
       someone and having the trigger instantly re-enroll them would make removal
       impossible. */
    const managed = input.autoPlanEnrollments !== undefined;
    const finalNext = managed ? next : applyAutoPlanAutomations(lead, next);
    await updateLead(finalNext);
    return finalNext;
}
