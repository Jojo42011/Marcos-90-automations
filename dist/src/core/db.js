"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeCrmIntent = normalizeCrmIntent;
exports.normalizeCrmTags = normalizeCrmTags;
exports.normalizeCrmStatus = normalizeCrmStatus;
exports.resetMemoryStore = resetMemoryStore;
exports.getLead = getLead;
exports.getLeadById = getLeadById;
exports.phoneMatchKey = phoneMatchKey;
exports.findLeadByPhoneDigits = findLeadByPhoneDigits;
exports.createLead = createLead;
exports.updateLead = updateLead;
exports.getConversation = getConversation;
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
exports.updateLeadCrmFields = updateLeadCrmFields;
const fs_1 = require("fs");
const path_1 = require("path");
const types_js_1 = require("./types.js");
const deals_js_1 = require("./deals.js");
const tagTemplates_js_1 = require("./tagTemplates.js");
const users_js_1 = require("./users.js");
const tasks_js_1 = require("./tasks.js");
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
let idCounter = 1;
function persistToFile() {
    try {
        (0, fs_1.mkdirSync)((0, path_1.dirname)(DB_PATH), { recursive: true });
        const data = {
            idCounter,
            leadsById: Object.fromEntries(leadsById),
            leadKeyToId: Object.fromEntries(leadKeyToId),
            conversationsByLeadId: Object.fromEntries(conversationsByLeadId),
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
    idCounter = 1;
    persistToFile();
}
function nowIso() {
    return new Date().toISOString();
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
/** Lookup by internal lead id (CRM / Sendblue). */
async function getLeadById(leadId) {
    const id = String(leadId || "").trim();
    if (!id)
        return null;
    return leadsById.get(id) ?? null;
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
async function createLead(lead) {
    const id = String(idCounter++);
    const createdAt = nowIso();
    const next = normalizeCrmDefaults({ ...lead, id, createdAt, updatedAt: createdAt });
    leadsById.set(id, next);
    leadKeyToId.set(leadKey(lead.platform, lead.userId), id);
    conversationsByLeadId.set(id, { messages: [] });
    persistToFile();
    return next;
}
async function updateLead(lead) {
    const existing = leadsById.get(lead.id);
    if (!existing) {
        leadsById.set(lead.id, normalizeCrmDefaults({ ...lead, createdAt: nowIso(), updatedAt: nowIso() }));
        persistToFile();
        return leadsById.get(lead.id);
    }
    const updated = normalizeCrmDefaults({ ...lead, updatedAt: nowIso() });
    leadsById.set(lead.id, updated);
    persistToFile();
    return updated;
}
async function getConversation(leadId) {
    return conversationsByLeadId.get(leadId) ?? { messages: [] };
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
        out.push({
            planId,
            planName: typeof e.planName === "string" ? e.planName : "",
            enrolledAt: typeof e.enrolledAt === "string" && e.enrolledAt ? e.enrolledAt : nowIso(),
            currentStepIndex: typeof e.currentStepIndex === "number" && e.currentStepIndex >= 0 ? e.currentStepIndex : 0,
            completedSteps: Array.isArray(e.completedSteps)
                ? e.completedSteps.filter((s) => typeof s === "string")
                : [],
            status,
        });
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
        (lead.assignedUserId ?? null) === assignedUserId &&
        (lead.assignedUserName ?? null) === assignedUserName) {
        return lead;
    }
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
        });
    }
    leads.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    const deals = (0, deals_js_1.getDeals)();
    const totalGCI = (0, deals_js_1.sumClosedDealGCI)(deals);
    const tasksSummary = (0, tasks_js_1.buildTasksSummary)();
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
            const base = criteria ?? { priceCap: null, beds: null, baths: null, area: null };
            criteria = {
                priceCap: input.criteria.priceCap !== undefined ? input.criteria.priceCap : base.priceCap,
                beds: input.criteria.beds !== undefined ? input.criteria.beds : base.beds,
                baths: input.criteria.baths !== undefined ? input.criteria.baths : base.baths,
                area: input.criteria.area !== undefined ? input.criteria.area : base.area,
            };
        }
    }
    const next = {
        ...lead,
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
    };
    await updateLead(next);
    return next;
}
