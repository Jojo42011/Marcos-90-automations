"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMarcoLogLevel = getMarcoLogLevel;
exports.marcoCorrelationId = marcoCorrelationId;
exports.newMarcoRequestId = newMarcoRequestId;
exports.previewText = previewText;
exports.marcoLog = marcoLog;
exports.marcoLogDebug = marcoLogDebug;
const crypto_1 = require("crypto");
function getMarcoLogLevel() {
    const v = process.env.MARCO_LOG_LEVEL?.trim().toLowerCase();
    if (!v || v === "info" || v === "1" || v === "true")
        return "info";
    if (v === "off" || v === "0" || v === "false" || v === "none")
        return "off";
    if (v === "debug" || v === "verbose" || v === "2")
        return "debug";
    return "info";
}
/** Stable pseudonymous id for correlating turns without logging raw subscriber ids. */
function marcoCorrelationId(platform, userId) {
    return (0, crypto_1.createHash)("sha256")
        .update(`${platform}::${userId}`)
        .digest("hex")
        .slice(0, 12);
}
function newMarcoRequestId() {
    return (0, crypto_1.randomUUID)();
}
/** Single-line preview for logs (not full PII dump). */
function previewText(s, max = 200) {
    if (s == null || s === "")
        return "";
    const t = s.replace(/\s+/g, " ").trim();
    if (t.length <= max)
        return t;
    return `${t.slice(0, max)}…`;
}
function marcoLog(event, fields) {
    if (getMarcoLogLevel() === "off")
        return;
    console.log(JSON.stringify({
        marco: true,
        ts: new Date().toISOString(),
        event,
        ...fields,
    }));
}
function marcoLogDebug(event, fields) {
    if (getMarcoLogLevel() !== "debug")
        return;
    marcoLog(event, { ...fields, _level: "debug" });
}
