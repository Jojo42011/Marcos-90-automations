"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetMemoryStore = resetMemoryStore;
exports.getLead = getLead;
exports.createLead = createLead;
exports.updateLead = updateLead;
exports.getConversation = getConversation;
exports.appendMessage = appendMessage;
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
