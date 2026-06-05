"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getActiveDialSession = getActiveDialSession;
exports.saveDialSession = saveDialSession;
exports.clearDialSession = clearDialSession;
exports.createDialSession = createDialSession;
exports.advanceDialSession = advanceDialSession;
exports.pauseDialSession = pauseDialSession;
exports.resumeDialSession = resumeDialSession;
exports.completeDialSession = completeDialSession;
exports.getDialSessionHistory = getDialSessionHistory;
exports.getCurrentDialLead = getCurrentDialLead;
exports.getDialedLeadsInSession = getDialedLeadsInSession;
const fs_1 = require("fs");
const path_1 = require("path");
const MAX_HISTORY = 50;
function resolveDataDir() {
    const flyDb = "/data/db.json";
    const localDb = (0, path_1.join)(process.cwd(), "data", "local-dashboard-db.json");
    const dbPath = process.env.DB_JSON_PATH?.trim() || ((0, fs_1.existsSync)(flyDb) ? flyDb : localDb);
    return (0, path_1.dirname)(dbPath);
}
function dialSessionPath() {
    const explicit = process.env.DIAL_SESSION_JSON_PATH?.trim();
    if (explicit)
        return explicit;
    return (0, path_1.join)(resolveDataDir(), "dial-session.json");
}
function dialHistoryPath() {
    const explicit = process.env.DIAL_SESSION_HISTORY_JSON_PATH?.trim();
    if (explicit)
        return explicit;
    return (0, path_1.join)(resolveDataDir(), "dial-session-history.json");
}
function nowIso() {
    return new Date().toISOString();
}
function genSessionId() {
    return `dial_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function writeJson(path, data) {
    (0, fs_1.mkdirSync)((0, path_1.dirname)(path), { recursive: true });
    (0, fs_1.writeFileSync)(path, JSON.stringify(data, null, 2), "utf8");
}
function readSessionFile() {
    const path = dialSessionPath();
    try {
        if (!(0, fs_1.existsSync)(path))
            return null;
        const raw = (0, fs_1.readFileSync)(path, "utf8");
        if (!raw.trim())
            return null;
        const data = JSON.parse(raw);
        if (!data || typeof data !== "object" || !Array.isArray(data.leads))
            return null;
        return normalizeSession(data);
    }
    catch (err) {
        console.error("[dialSession] read failed:", err);
        return null;
    }
}
function normalizeLeadStatus(s) {
    const v = String(s || "pending");
    if (v === "pending" ||
        v === "calling" ||
        v === "completed" ||
        v === "skipped" ||
        v === "no_answer" ||
        v === "voicemail") {
        return v;
    }
    return "pending";
}
function normalizeSession(data) {
    const status = data.status === "active" || data.status === "paused" || data.status === "completed" || data.status === "idle"
        ? data.status
        : "active";
    return {
        id: typeof data.id === "string" ? data.id : genSessionId(),
        createdAt: typeof data.createdAt === "string" ? data.createdAt : nowIso(),
        status,
        currentIndex: typeof data.currentIndex === "number" && data.currentIndex >= 0 ? data.currentIndex : 0,
        totalCalled: typeof data.totalCalled === "number" ? data.totalCalled : 0,
        totalAnswered: typeof data.totalAnswered === "number" ? data.totalAnswered : 0,
        totalSkipped: typeof data.totalSkipped === "number" ? data.totalSkipped : 0,
        leads: data.leads.map((l) => ({
            leadId: String(l.leadId || ""),
            name: String(l.name || ""),
            phone: String(l.phone || ""),
            status: normalizeLeadStatus(l.status),
            callStarted: typeof l.callStarted === "string" ? l.callStarted : undefined,
            callEnded: typeof l.callEnded === "string" ? l.callEnded : undefined,
            duration: typeof l.duration === "number" && l.duration >= 0 ? l.duration : undefined,
            outcome: typeof l.outcome === "string" ? l.outcome : undefined,
            aiSuggestionsCount: typeof l.aiSuggestionsCount === "number" && l.aiSuggestionsCount >= 0 ? l.aiSuggestionsCount : undefined,
        })),
    };
}
function normalizeOutcome(outcome) {
    const o = outcome.trim().toLowerCase();
    if (o === "answered" || o === "✅ answered") {
        return { status: "completed", answered: true, skipped: false };
    }
    if (o === "no_answer" || o === "no answer" || o.includes("no answer")) {
        return { status: "no_answer", answered: false, skipped: false };
    }
    if (o === "voicemail" || o.includes("voicemail")) {
        return { status: "voicemail", answered: false, skipped: false };
    }
    if (o === "skip" || o === "skipped" || o.includes("skip")) {
        return { status: "skipped", answered: false, skipped: true };
    }
    return { status: "completed", answered: true, skipped: false };
}
function getActiveDialSession() {
    const session = readSessionFile();
    if (!session || session.status === "completed" || session.status === "idle")
        return null;
    return session;
}
function saveDialSession(session) {
    try {
        writeJson(dialSessionPath(), normalizeSession(session));
    }
    catch (err) {
        console.error("[dialSession] save failed:", err);
    }
}
function clearDialSession() {
    try {
        const path = dialSessionPath();
        if ((0, fs_1.existsSync)(path))
            (0, fs_1.unlinkSync)(path);
    }
    catch (err) {
        console.error("[dialSession] clear failed:", err);
    }
}
function createDialSession(leads) {
    const session = {
        id: genSessionId(),
        createdAt: nowIso(),
        status: "active",
        leads: leads.map((l) => ({ ...l, status: "pending" })),
        currentIndex: 0,
        totalCalled: 0,
        totalAnswered: 0,
        totalSkipped: 0,
    };
    if (session.leads.length > 0) {
        session.leads[0].status = "calling";
        session.leads[0].callStarted = nowIso();
    }
    saveDialSession(session);
    return session;
}
function advanceDialSession(outcome, opts) {
    const session = readSessionFile();
    if (!session || session.status === "completed")
        return null;
    const idx = session.currentIndex;
    if (idx < 0 || idx >= session.leads.length)
        return null;
    const lead = session.leads[idx];
    const ended = nowIso();
    const started = lead.callStarted ? new Date(lead.callStarted).getTime() : Date.now();
    const durationSec = typeof opts?.duration === "number" && opts.duration >= 0
        ? Math.round(opts.duration)
        : Math.max(0, Math.round((Date.now() - started) / 1000));
    const mapped = normalizeOutcome(outcome);
    lead.status = mapped.status;
    lead.outcome = outcome.trim() || mapped.status;
    if (opts?.notes?.trim())
        lead.outcome = `${lead.outcome} — ${opts.notes.trim()}`;
    lead.callEnded = ended;
    lead.duration = durationSec;
    session.totalCalled += 1;
    if (mapped.answered)
        session.totalAnswered += 1;
    if (mapped.skipped)
        session.totalSkipped += 1;
    session.currentIndex = idx + 1;
    if (session.currentIndex >= session.leads.length) {
        session.status = "completed";
    }
    else {
        const next = session.leads[session.currentIndex];
        next.status = "calling";
        next.callStarted = nowIso();
        session.status = "active";
    }
    saveDialSession(session);
    return session;
}
function pauseDialSession() {
    const session = readSessionFile();
    if (!session || session.status !== "active")
        return null;
    session.status = "paused";
    saveDialSession(session);
    return session;
}
function resumeDialSession() {
    const session = readSessionFile();
    if (!session || session.status !== "paused")
        return null;
    session.status = "active";
    saveDialSession(session);
    return session;
}
function archiveSession(session) {
    const durationSec = session.leads.reduce((s, l) => s + (l.duration || 0), 0);
    const record = {
        id: session.id,
        completedAt: nowIso(),
        totalCalled: session.totalCalled,
        totalAnswered: session.totalAnswered,
        totalSkipped: session.totalSkipped,
        leads: session.leads,
        durationSec,
    };
    let history = [];
    const path = dialHistoryPath();
    try {
        if ((0, fs_1.existsSync)(path)) {
            const raw = (0, fs_1.readFileSync)(path, "utf8");
            if (raw.trim()) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed))
                    history = parsed;
            }
        }
    }
    catch {
        history = [];
    }
    history.unshift(record);
    history = history.slice(0, MAX_HISTORY);
    try {
        writeJson(path, history);
    }
    catch (err) {
        console.error("[dialSession] history save failed:", err);
    }
}
function completeDialSession() {
    const session = readSessionFile();
    if (!session)
        return null;
    session.status = "completed";
    saveDialSession(session);
    archiveSession(session);
    return session;
}
function getDialSessionHistory(limit = 5) {
    const path = dialHistoryPath();
    try {
        if (!(0, fs_1.existsSync)(path))
            return [];
        const raw = (0, fs_1.readFileSync)(path, "utf8");
        if (!raw.trim())
            return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.slice(0, limit);
    }
    catch (err) {
        console.error("[dialSession] history read failed:", err);
        return [];
    }
}
/** Current lead in an active/paused session (for logging). */
function getCurrentDialLead(session) {
    const idx = session.currentIndex;
    if (idx < 0 || idx >= session.leads.length)
        return null;
    return session.leads[idx] ?? null;
}
/** Leads already dialed in this session (for end-of-session logging). */
function getDialedLeadsInSession(session) {
    return session.leads.filter((l) => l.status !== "pending" &&
        l.status !== "calling" &&
        (l.callEnded || l.outcome || l.duration !== undefined));
}
