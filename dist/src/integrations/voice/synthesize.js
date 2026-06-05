"use strict";
/** TTS removed — Harvey voice uses Gemini Live / Gemini TTS. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTtsProvider = getTtsProvider;
exports.synthesizeSpeech = synthesizeSpeech;
function getTtsProvider() {
    return "none";
}
async function synthesizeSpeech(_rawText) {
    throw new Error("Legacy TTS removed — use POST /api/jarvis/gemini-tts");
}
