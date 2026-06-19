"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTtsPrompt = buildTtsPrompt;
exports.generateTTS = generateTTS;
const founderPrompt_js_1 = require("../founderPrompt.js");
function buildTtsPrompt(spokenText) {
    return `Synthesize speech. Do not read the director's notes aloud.
### DIRECTOR'S NOTES
Style: ${founderPrompt_js_1.VOICE_CHARACTER}
#### TRANSCRIPT
${spokenText}`;
}
async function generateTTS(text) {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key || !text.trim())
        return null;
    const model = process.env.GEMINI_TTS_MODEL?.trim() || "gemini-3.1-flash-tts-preview";
    const voiceName = process.env.GEMINI_TTS_VOICE?.trim() || "Kore";
    const prompt = buildTtsPrompt(text);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName },
                    },
                },
            },
        }),
    });
    if (!res.ok) {
        console.error("[hull/tts] Gemini error:", res.status, await res.text().catch(() => ""));
        return null;
    }
    const data = (await res.json());
    const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    const b64 = part?.inlineData?.data;
    if (!b64)
        return null;
    const pcm = Buffer.from(b64, "base64");
    const mime = (part?.inlineData?.mimeType || "").toLowerCase();
    const rateMatch = mime.match(/rate\s*=\s*(\d+)/i);
    let sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
    if (!Number.isFinite(sampleRate) || sampleRate < 8000)
        sampleRate = 24000;
    return { pcm, sampleRate };
}
