"use strict";
/** Harvey voice diagnostics — enable with HARVEY_VOICE_LOG=1 or MARCO_LOG_LEVEL=debug */
Object.defineProperty(exports, "__esModule", { value: true });
exports.harveyVoiceLogEnabled = harveyVoiceLogEnabled;
exports.voiceLog = voiceLog;
function harveyVoiceLogEnabled() {
    const v = process.env.HARVEY_VOICE_LOG?.trim().toLowerCase();
    if (v === "1" || v === "true" || v === "yes" || v === "on")
        return true;
    const m = process.env.MARCO_LOG_LEVEL?.trim().toLowerCase();
    return m === "debug" || m === "verbose" || m === "2";
}
function voiceLog(msg, data) {
    if (!harveyVoiceLogEnabled())
        return;
    if (data && Object.keys(data).length) {
        console.log(`[HarveyVoice] ${msg}`, JSON.stringify(data));
    }
    else {
        console.log(`[HarveyVoice] ${msg}`);
    }
}
