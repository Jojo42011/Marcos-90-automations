"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidTimeZone = isValidTimeZone;
exports.getCommandSettings = getCommandSettings;
exports.setCommandTimeZone = setCommandTimeZone;
exports.commandDateString = commandDateString;
exports.commandDatePlus = commandDatePlus;
exports.setUserLayout = setUserLayout;
exports.getUserLayout = getUserLayout;
const fs_1 = require("fs");
const path_1 = require("path");
const DEFAULT_TIME_ZONE = "America/Chicago";
function resolveSettingsPath() {
    const explicit = process.env.COMMAND_SETTINGS_JSON_PATH?.trim();
    if (explicit)
        return explicit;
    const flyDb = "/data/db.json";
    const localDb = (0, path_1.join)(process.cwd(), "data", "local-dashboard-db.json");
    const dbPath = process.env.DB_JSON_PATH?.trim() || ((0, fs_1.existsSync)(flyDb) ? flyDb : localDb);
    return (0, path_1.join)((0, path_1.dirname)(dbPath), "command-settings.json");
}
const SETTINGS_PATH = resolveSettingsPath();
/** True when the runtime actually knows this zone, so we never store a dud. */
function isValidTimeZone(tz) {
    if (typeof tz !== "string" || !tz.trim())
        return false;
    try {
        new Intl.DateTimeFormat("en-CA", { timeZone: tz.trim() }).format(new Date());
        return true;
    }
    catch {
        return false;
    }
}
function defaults() {
    return { timeZone: DEFAULT_TIME_ZONE, layouts: {}, gridOn: {}, updatedAt: new Date().toISOString() };
}
/** Keep stored placements sane: whole numbers, on-grid, bounded size. */
function sanitizeLayout(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== "object")
            continue;
        const w = item;
        const id = typeof w.id === "string" ? w.id.trim().slice(0, 40) : "";
        if (!id)
            continue;
        const num = (v, min, max, dflt) => {
            const n = Math.round(Number(v));
            return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
        };
        out.push({
            id,
            x: num(w.x, 0, 11, 0),
            y: num(w.y, 0, 200, 0),
            w: num(w.w, 2, 12, 6),
            h: num(w.h, 2, 60, 8),
            hidden: w.hidden === true,
        });
        if (out.length >= 24)
            break;
    }
    return out;
}
function getCommandSettings() {
    try {
        if (!(0, fs_1.existsSync)(SETTINGS_PATH))
            return defaults();
        const raw = JSON.parse((0, fs_1.readFileSync)(SETTINGS_PATH, "utf8"));
        return {
            timeZone: isValidTimeZone(raw?.timeZone) ? raw.timeZone : DEFAULT_TIME_ZONE,
            updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
            layouts: raw?.layouts && typeof raw.layouts === "object"
                ? Object.fromEntries(Object.entries(raw.layouts)
                    .slice(0, 50)
                    .map(([k, v]) => [k, sanitizeLayout(v)]))
                : {},
            gridOn: raw?.gridOn && typeof raw.gridOn === "object"
                ? Object.fromEntries(Object.entries(raw.gridOn)
                    .slice(0, 50).map(([k, v]) => [k, v === true]))
                : {},
            updatedBy: typeof raw?.updatedBy === "string" ? raw.updatedBy : undefined,
        };
    }
    catch {
        return defaults();
    }
}
function setCommandTimeZone(timeZone, updatedBy) {
    if (!isValidTimeZone(timeZone)) {
        throw new Error(`Unknown time zone: ${timeZone}`);
    }
    /* Spread the current settings first: this file also holds every user's
       saved dashboard layout, and rebuilding from scratch here silently wiped
       them all on any time-zone change. */
    const current = getCommandSettings();
    const next = {
        ...current,
        timeZone: timeZone.trim(),
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy?.trim() || undefined,
    };
    (0, fs_1.mkdirSync)((0, path_1.dirname)(SETTINGS_PATH), { recursive: true });
    (0, fs_1.writeFileSync)(SETTINGS_PATH, JSON.stringify(next, null, 2));
    return next;
}
/** "YYYY-MM-DD" for `at` in the command zone. */
function commandDateString(at = new Date(), tz = getCommandSettings().timeZone) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
}
/** Today in the command zone, offset by whole days. */
function commandDatePlus(days, at = new Date(), tz = getCommandSettings().timeZone) {
    const base = commandDateString(at, tz);
    const [y, m, d] = base.split("-").map(Number);
    const shifted = new Date(Date.UTC(y, m - 1, d));
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.toISOString().slice(0, 10);
}
/** Save one user's dashboard arrangement without touching anyone else's. */
function setUserLayout(userId, layout, gridOn) {
    const uid = String(userId || "").trim().slice(0, 60);
    if (!uid)
        throw new Error("userId required");
    const current = getCommandSettings();
    const layouts = { ...(current.layouts || {}) };
    const flags = { ...(current.gridOn || {}) };
    const clean = sanitizeLayout(layout);
    if (clean.length)
        layouts[uid] = clean;
    else
        delete layouts[uid];
    if (typeof gridOn === "boolean")
        flags[uid] = gridOn;
    const next = { ...current, layouts, gridOn: flags, updatedAt: new Date().toISOString() };
    (0, fs_1.mkdirSync)((0, path_1.dirname)(SETTINGS_PATH), { recursive: true });
    (0, fs_1.writeFileSync)(SETTINGS_PATH, JSON.stringify(next, null, 2));
    return { layout: clean, gridOn: resolveGridOn(next, uid) };
}
function resolveGridOn(settings, uid) {
    const explicit = (settings.gridOn || {})[uid];
    if (typeof explicit === "boolean")
        return explicit;
    return ((settings.layouts || {})[uid] || []).length > 0;
}
function getUserLayout(userId) {
    const uid = String(userId || "").trim();
    const settings = getCommandSettings();
    return {
        layout: (settings.layouts || {})[uid] || [],
        gridOn: resolveGridOn(settings, uid),
    };
}
