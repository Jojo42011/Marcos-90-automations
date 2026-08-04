"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.needsSonnet = needsSonnet;
exports.isSocialTurn = isSocialTurn;
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
/* A pure pleasantry ("how are you", "thanks man") carries no tools and no
   operational prompt, and runs on Haiku whatever mode asked (playbook §7:
   don't send 40 tool schemas to say hello; route social turns to the fast
   model's own rate bucket). The match is ANCHORED and short on purpose —
   anything ambiguous gets the full set, because trading correctness for
   tokens is the one swap the playbook forbids. */
const SOCIAL_RE = /^(hey|hi|hello|yo|good (morning|afternoon|evening)|gm|gn|good night|what'?s up|sup|how (are|r) (you|ya)( doing| holding up| feeling)?( today| this morning| tonight)?|how'?s it going|how'?s your (day|morning|night)( going| been)?|how was your (day|night|weekend)|you (there|good|up)|thanks?( a lot| man| buddy)?|thank you|appreciate (it|you)|ha(ha)+|lol|that'?s funny|nice one|love (it|that))[\s!,.?]*$/i;
function isSocialTurn(message) {
    const t = message.trim().toLowerCase().replace(/[\s!,.?]*harvey[\s!,.?]*$/i, "").trim();
    if (!t || t.length > 60)
        return false;
    if (needsSonnet(t))
        return false;
    return SOCIAL_RE.test(t);
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
