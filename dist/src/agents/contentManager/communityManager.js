"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.triageDm = triageDm;
exports.trackCommentManaged = trackCommentManaged;
exports.trackDmTriaged = trackDmTriaged;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const db_js_1 = require("../../core/db.js");
const state_js_1 = require("../../core/state.js");
const contentDb_js_1 = require("../../core/contentDb.js");
const anthropic = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const US_PHONE_RE = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/;
function normalizePhone(raw) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1"))
        return `+${digits}`;
    if (digits.length === 10)
        return `+1${digits}`;
    return raw.trim();
}
function extractPhone(message) {
    const match = message.match(US_PHONE_RE);
    if (!match)
        return null;
    return normalizePhone(match[0]);
}
async function classifyDm(message) {
    if (!process.env.ANTHROPIC_API_KEY?.trim()) {
        if (/\b(price|tour|showing|buy|interested|available|bedroom)\b/i.test(message)) {
            return "lead_inquiry";
        }
        return "general_question";
    }
    const response = await anthropic.messages.create({
        model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 50,
        system: 'Classify this social DM for a real estate agent. Reply with exactly one label: lead_inquiry, general_question, spam, or existing_client. JSON only: { "classification": "..." }',
        messages: [{ role: "user", content: message }],
    });
    const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
    const match = text.match(/lead_inquiry|general_question|spam|existing_client/);
    return match?.[0] ?? "general_question";
}
async function routePhoneToCrm(input) {
    const existing = await (0, db_js_1.getLead)(input.platform, input.userId);
    if (existing) {
        if (!existing.phone?.trim()) {
            await (0, db_js_1.updateLeadCrmFields)({
                leadId: existing.id,
                phone: input.phone,
                name: existing.name ?? input.username ?? null,
                source: existing.source ?? "content_dm",
            });
        }
        return;
    }
    await (0, db_js_1.createLead)({
        platform: input.platform,
        userId: input.userId,
        username: input.username ?? null,
        name: input.username ?? null,
        phone: input.phone,
        email: null,
        state: state_js_1.FunnelStage.New,
        source: "content_dm",
        adCampaign: null,
        propertyInquired: null,
        criteria: null,
        brivityId: null,
        crmStatus: "new",
        crmStage: "new",
        crmPriority: "normal",
        crmIntent: "buyer",
        crmCallQueue: "urgent",
        crmNotes: "Captured via Content Manager DM triage",
    });
}
async function triageDm(input) {
    const classification = await classifyDm(input.message);
    const phone = extractPhone(input.message);
    let leadCaptureId = null;
    if (phone) {
        let routed = false;
        try {
            await routePhoneToCrm({
                platform: input.platform,
                userId: input.userId,
                username: input.username,
                phone,
            });
            routed = true;
        }
        catch (err) {
            console.error("[content-manager/community] CRM route failed:", err);
        }
        const capture = (0, contentDb_js_1.insertLeadCapture)({
            platform: input.platform,
            platformUserId: input.userId,
            phoneNumber: phone,
            capturedFrom: "dm",
            rawMessage: input.message,
            routedToCrm: routed,
            routedAt: routed ? new Date().toISOString() : null,
        });
        (0, contentDb_js_1.incrementDailyTarget)((0, contentDb_js_1.todayDateCst)(), "phone_numbers_captured");
        leadCaptureId = capture.id;
    }
    trackDmTriaged();
    return {
        classification,
        phoneFound: Boolean(phone),
        phone,
        leadCaptureId,
    };
}
function trackCommentManaged() {
    (0, contentDb_js_1.incrementDailyTarget)((0, contentDb_js_1.todayDateCst)(), "comments_managed");
}
function trackDmTriaged() {
    (0, contentDb_js_1.incrementDailyTarget)((0, contentDb_js_1.todayDateCst)(), "dms_triaged");
}
