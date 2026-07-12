"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOrUpdateLead = createOrUpdateLead;
exports.syncLead = syncLead;
const axios_1 = __importDefault(require("axios"));
const BRIVITY_BASE_URL = process.env.BRIVITY_BASE_URL || "https://app.brivityidx.com/api";
const BRIVITY_API_KEY = process.env.BRIVITY_API_KEY || "";
const brivityClient = axios_1.default.create({
    baseURL: BRIVITY_BASE_URL,
    headers: {
        Authorization: BRIVITY_API_KEY,
        "Content-Type": "application/json",
    },
    timeout: 12000,
});
function normalizeSource(platform) {
    return platform.toLowerCase().includes("tik") ? "TikTok" : "Instagram";
}
function leadStage(lead) {
    return String(lead.state);
}
function firstNameFromLead(lead) {
    if (lead.name?.trim())
        return lead.name.trim();
    if (lead.username?.trim())
        return lead.username.trim();
    return "Lead";
}
function toContactPayload(lead) {
    return {
        first_name: firstNameFromLead(lead),
        phone: lead.phone ?? undefined,
        email: lead.email ?? undefined,
        source: normalizeSource(lead.platform),
        stage: leadStage(lead),
        notes: lead.crmNotes && lead.crmNotes.length > 0 ? lead.crmNotes.join("; ") : undefined,
    };
}
async function findByPhone(phone) {
    try {
        const response = await brivityClient.get("/contacts", { params: { phone } });
        const data = response.data;
        if (Array.isArray(data) && data.length > 0)
            return data[0];
        if (data && typeof data === "object") {
            const maybe = data;
            if (Array.isArray(maybe.contacts) && maybe.contacts.length > 0)
                return maybe.contacts[0];
            if (Array.isArray(maybe.data) && maybe.data.length > 0)
                return maybe.data[0];
        }
        return null;
    }
    catch (error) {
        console.error("[Brivity] findByPhone failed:", error);
        return null;
    }
}
async function createOrUpdateLead(lead) {
    try {
        const payload = toContactPayload(lead);
        const response = await brivityClient.post("/contacts", payload);
        return response.data ?? null;
    }
    catch (error) {
        console.error("[Brivity] createOrUpdateLead failed:", error);
        return null;
    }
}
async function syncLead(lead) {
    try {
        if (!lead.phone && !lead.email) {
            return null;
        }
        if (lead.phone) {
            const existing = await findByPhone(lead.phone);
            if (existing?.id) {
                const payload = toContactPayload(lead);
                const response = await brivityClient.put(`/contacts/${existing.id}`, payload);
                return response.data ?? existing;
            }
        }
        return await createOrUpdateLead(lead);
    }
    catch (error) {
        console.error("[Brivity] syncLead failed:", error);
        return null;
    }
}
