"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultPreferences = void 0;
exports.accountPreferences = accountPreferences;
exports.saveAccountPreferences = saveAccountPreferences;
const authStore_js_1 = require("./authStore.js");
exports.defaultPreferences = { theme: "system", accent: "#0e7490", density: "comfortable", fontSize: 14, reducedMotion: false };
function accountPreferences(actor) {
    const raw = (0, authStore_js_1.getSecurityState)("preferences:" + actor);
    return { ...exports.defaultPreferences, ...(raw ? JSON.parse(raw) : {}) };
}
function saveAccountPreferences(actor, input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Invalid settings");
    const next = { ...accountPreferences(actor) };
    for (const [key, value] of Object.entries(input)) {
        if (key === "theme" && ["system", "light", "dark"].includes(String(value)))
            next.theme = String(value);
        else if (key === "accent" && /^#[0-9a-f]{6}$/i.test(String(value)))
            next.accent = String(value);
        else if (key === "density" && ["comfortable", "compact"].includes(String(value)))
            next.density = String(value);
        else if (key === "fontSize" && typeof value === "number" && value >= 12 && value <= 20)
            next.fontSize = value;
        else if (key === "reducedMotion" && typeof value === "boolean")
            next.reducedMotion = value;
        else
            throw new Error("Invalid setting: " + key);
    }
    (0, authStore_js_1.setSecurityState)("preferences:" + actor, JSON.stringify(next));
    return next;
}
