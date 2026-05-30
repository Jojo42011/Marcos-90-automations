"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetMemoryStore = resetMemoryStore;
exports.getLead = getLead;
exports.getLeadById = getLeadById;
exports.phoneMatchKey = phoneMatchKey;
exports.findLeadByPhoneDigits = findLeadByPhoneDigits;
exports.createLead = createLead;
exports.updateLead = updateLead;
exports.getConversation = getConversation;
exports.appendMessage = appendMessage;
exports.getDashboardSnapshot = getDashboardSnapshot;
exports.listCrmLeads = listCrmLeads;
exports.updateLeadCrmFields = updateLeadCrmFields;
const fs_1 = require("fs");
const path_1 = require("path");
/**
 * File-backed store: persists to /data/db.json (Fly volume) or DB_JSON_PATH.
 * Loads on module init; sync write after createLead, updateLead, appendMessage, resetMemoryStore.
 */
const DB_PATH = process.env.DB_JSON_PATH?.trim() || "/data/db.json";
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
    const next = { ...lead, id, createdAt, updatedAt: createdAt };
    leadsById.set(id, next);
    leadKeyToId.set(leadKey(lead.platform, lead.userId), id);
    conversationsByLeadId.set(id, { messages: [] });
    persistToFile();
    return next;
}
async function updateLead(lead) {
    const existing = leadsById.get(lead.id);
    if (!existing) {
        leadsById.set(lead.id, { ...lead, createdAt: nowIso(), updatedAt: nowIso() });
        persistToFile();
        return leadsById.get(lead.id);
    }
    const updated = { ...lead, updatedAt: nowIso() };
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
function normalizeCrmDefaults(lead) {
    const crmStatus = lead.crmStatus ?? "not_contacted";
    const crmStage = lead.crmStage ?? "new";
    const crmPriority = lead.crmPriority ?? "normal";
    const crmNotes = lead.crmNotes ?? null;
    const rawIntent = lead.crmIntent;
    const crmIntent = rawIntent === "seller" ? "seller" : "buyer";
    const rawQ = lead.crmCallQueue;
    const crmCallQueue = rawQ === "urgent" || rawQ === "routine" ? rawQ : "none";
    const adCampaign = lead.adCampaign ?? null;
    if (lead.crmStatus === crmStatus &&
        lead.crmStage === crmStage &&
        lead.crmPriority === crmPriority &&
        lead.crmNotes === crmNotes &&
        lead.crmIntent === crmIntent &&
        lead.crmCallQueue === crmCallQueue &&
        lead.adCampaign === adCampaign) {
        return lead;
    }
    return { ...lead, crmStatus, crmStage, crmPriority, crmNotes, crmIntent, crmCallQueue, adCampaign };
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
            createdAt: lead.createdAt,
            updatedAt: lead.updatedAt,
            userMessageCount,
            assistantMessageCount,
            totalMessages: msgs.length,
            lastMessageAt,
        });
    }
    leads.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
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
    };
}
async function listCrmLeads() {
    const snap = await getDashboardSnapshot();
    return snap.leads;
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
        crmStatus: input.crmStatus ?? lead.crmStatus,
        crmStage: input.crmStage ?? lead.crmStage,
        crmPriority: input.crmPriority ?? lead.crmPriority,
        crmIntent: input.crmIntent ?? lead.crmIntent,
        crmCallQueue: input.crmCallQueue ?? lead.crmCallQueue,
        crmNotes: input.crmNotes !== undefined ? input.crmNotes : lead.crmNotes,
        name: input.name !== undefined ? input.name : lead.name,
        email: input.email !== undefined ? input.email : lead.email,
        phone: input.phone !== undefined ? input.phone : lead.phone,
        source: input.source !== undefined ? input.source : lead.source,
        propertyInquired: input.propertyInquired !== undefined ? input.propertyInquired : lead.propertyInquired,
        brivityId: input.brivityId !== undefined ? input.brivityId : lead.brivityId,
        criteria,
    };
    await updateLead(next);
    return next;
}
