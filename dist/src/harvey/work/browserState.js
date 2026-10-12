"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.restorableUrl = restorableUrl;
exports.readTabs = readTabs;
exports.writeTabs = writeTabs;
exports.resultText = resultText;
exports.parseTabs = parseTabs;
exports.browserRead = browserRead;
exports.recoveryFor = recoveryFor;
const fs_1 = require("fs");
const crypto_1 = require("crypto");
function restorableUrl(value) {
    if (value === "about:blank")
        return true;
    try {
        const u = new URL(value);
        return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password;
    }
    catch {
        return false;
    }
}
function readTabs(path) {
    if (!(0, fs_1.existsSync)(path))
        return;
    const v = JSON.parse((0, fs_1.readFileSync)(path, "utf8"));
    if (!v || !Array.isArray(v.urls) || v.urls.some((u) => typeof u !== "string" || !restorableUrl(u)) || !Number.isInteger(v.active) || v.active < 0 || v.active >= Math.max(1, v.urls.length) || typeof v.open !== "boolean")
        throw new Error("Saved tab state is invalid; original file retained");
    return v;
}
function writeTabs(path, value) {
    const pending = path + "." + (0, crypto_1.randomUUID)() + ".pending";
    let fd;
    try {
        fd = (0, fs_1.openSync)(pending, "wx", 0o600);
        (0, fs_1.writeFileSync)(fd, JSON.stringify(value));
        (0, fs_1.fsyncSync)(fd);
        (0, fs_1.closeSync)(fd);
        fd = undefined;
        (0, fs_1.renameSync)(pending, path);
    }
    finally {
        if (fd !== undefined)
            (0, fs_1.closeSync)(fd);
        if ((0, fs_1.existsSync)(pending))
            (0, fs_1.unlinkSync)(pending);
    }
}
function resultText(result) { return (result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n"); }
function parseTabs(raw) {
    const rows = [...raw.matchAll(/^- (\d+):( \(current\))? \[.*\]\((.*)\)(?: \[crashed\])?$/gm)];
    if (!rows.length)
        return;
    // Unsupported internal URLs are represented by a blank tab, never executed on restore.
    return { urls: rows.map(r => restorableUrl(r[3]) ? r[3] : "about:blank"), active: Math.max(0, rows.findIndex(r => !!r[2])), open: true, updatedAt: new Date().toISOString() };
}
function browserRead(name, args) {
    return ["browser_snapshot", "browser_take_screenshot", "browser_read_snapshot", "browser_wait_for"].includes(name) || name === "browser_tabs" && args?.action === "list";
}
function recoveryFor(message, preflight = false) {
    if (preflight || /strict mode violation|resolved to \d+ elements|ref.*not found|not found in the current page snapshot|target changed|Invalid browser target/i.test(message))
        return { kind: "target", actionOutcome: "not_executed", safeToRetry: true, guidance: "Use the fresh snapshot, narrow to a unique observed target, or inspect the correct tab/frame. Do not guess selectors." };
    if (/intercepts pointer events|not visible|not enabled|not stable/i.test(message))
        return { kind: "obstructed", actionOutcome: "unknown", safeToRetry: false, guidance: "Inspect the current page and any overlay, loading state or disabled control. Verify whether the action happened before choosing a different target or waiting for readiness." };
    if (/closed|crash|connection|transport/i.test(message))
        return { kind: "connection", actionOutcome: "unknown", safeToRetry: false, guidance: "Inspect browser status before retrying. An explicit browser_recover can reopen saved tabs and cookies; it never repeats the interrupted action." };
    return { kind: /timeout/i.test(message) ? "timeout" : "browser", actionOutcome: "unknown", safeToRetry: false, guidance: "Inspect the resulting page and selected tab. Check whether the action succeeded before retrying; use a distinct observed approach. Stop only for a confirmed authorization, MFA/CAPTCHA, service or budget blocker." };
}
