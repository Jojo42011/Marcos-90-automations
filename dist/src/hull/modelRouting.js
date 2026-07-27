"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.needsSonnet = needsSonnet;
exports.getAethonModel = getAethonModel;
exports.getHaikuModel = getHaikuModel;
exports.getMaxTokens = getMaxTokens;
const SONNET_TRIGGERS = [
    "marco",
    "arthur",
    "joe",
    "gus",
    "client",
    "remember",
    "recall",
    "store",
    "learned",
    "memory",
    "graph",
    "read",
    "write",
    "list",
    "edit",
    "file",
    "build",
    "deploy",
    "fix",
    "analyze",
    "code",
    "search",
    "look up",
    "find",
    "what is",
    "price",
    "email",
    "calendar",
    "send",
    "book",
    "schedule",
    "lead",
    "tiktok",
    "instagram",
    "reel",
    "http", // any pasted link (reel/short/video) → Sonnet + tools so analyze_reel can fire
    "funnel",
    "mojo",
    "brivity",
    "transaction",
    "showing",
    "listing",
    // Tracker / Task Command / team vocabulary. Without these the keyword-gated
    // paths (voice, WhatsApp) get no tools for those subsystems and answer from
    // memory instead of the database.
    "tracker",
    "pipeline",
    "stage",
    "seller",
    "buyer",
    "task",
    "board",
    "due",
    "overdue",
    "checklist",
    "assigned",
    "team",
    "time zone",
    "timezone",
    "wesley",
    "kendrick",
    "carlos",
];
function needsSonnet(message) {
    const lower = message.toLowerCase();
    return SONNET_TRIGGERS.some((t) => lower.includes(t));
}
function getAethonModel() {
    return (process.env.AETHON_MODEL?.trim() ||
        process.env.HARVEY_MODEL?.trim() ||
        "claude-sonnet-4-6");
}
function getHaikuModel() {
    return process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5-20251001";
}
function getMaxTokens() {
    const n = parseInt(process.env.AETHON_MAX_TOKENS || "8192", 10);
    return Number.isFinite(n) ? n : 8192;
}
