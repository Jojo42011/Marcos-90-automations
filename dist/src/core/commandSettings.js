"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidTimeZone = isValidTimeZone;
exports.getCommandSettings = getCommandSettings;
exports.setCommandTimeZone = setCommandTimeZone;
exports.commandDateString = commandDateString;
exports.commandDatePlus = commandDatePlus;
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
    return { timeZone: DEFAULT_TIME_ZONE, updatedAt: new Date().toISOString() };
}
function getCommandSettings() {
    try {
        if (!(0, fs_1.existsSync)(SETTINGS_PATH))
            return defaults();
        const raw = JSON.parse((0, fs_1.readFileSync)(SETTINGS_PATH, "utf8"));
        return {
            timeZone: isValidTimeZone(raw?.timeZone) ? raw.timeZone : DEFAULT_TIME_ZONE,
            updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
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
    const next = {
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
