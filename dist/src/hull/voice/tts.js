"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ttsHealthReport = ttsHealthReport;
exports.generateTTS = generateTTS;
exports.clearTtsCache = clearTtsCache;
const speakNumbers_js_1 = require("./speakNumbers.js");
const voiceProfile_js_1 = require("./voiceProfile.js");
const ttsCache = new Map();
const TTS_CACHE_MAX = 50;
const health = {
    lastOk: null, lastError: null, lastAt: null, substitutedFrom: null, substitutedTo: null,
};
/**
 * Voice ids ElevenLabs has already rejected this boot. Without this every
 * single utterance would pay a doomed round trip before falling back, which
 * turns a fixed bug into a latency bug.
 */
const rejectedVoices = new Set();
function ttsHealthReport() {
    return { ...health };
}
/** ElevenLabs returns raw S16LE PCM when output_format=pcm_24000 — matches the client's Int16 decoder. */
const ELEVENLABS_SAMPLE_RATE = 24000;
/**
 * Flash v2.5 stays, deliberately. Harvey speaks inside a live conversation and
 * ElevenLabs' own guidance is that their more natural v3 model cannot run in
 * real time — its richness is bought with latency Harvey does not have. The
 * warmth comes from the voice and the delivery settings instead.
 */
const DEFAULT_MODEL = "eleven_flash_v2_5";
async function generateTTS(rawText) {
    const key = process.env.ELEVENLABS_API_KEY?.trim();
    if (!key || !rawText.trim())
        return null;
    /* Ear-text, not eye-text (playbook §6.2): "$40k" and "(210) 718-3874" come
       out of a low-latency TTS model flat or mangled, so numbers become words
       HERE, at the mouth — the UI keeps the readable form. */
    const text = (0, speakNumbers_js_1.sanitizeForSpeech)(rawText);
    if (!text.trim())
        return null;
    const profile = (0, voiceProfile_js_1.getVoiceProfile)();
    const delivery = (0, voiceProfile_js_1.effectiveDelivery)(profile);
    const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_MODEL;
    /* The cache key carries the VOICE and the DELIVERY, not just the words.
       Keyed on text alone, changing Harvey's voice would keep replaying whatever
       was already cached in the old one — the change would look broken for every
       line he had said before. */
    const cacheKey = [
        profile.voiceId, modelId,
        delivery.stability, delivery.similarityBoost, delivery.style, delivery.speakerBoost,
        profile.speed ?? "",
        text.trim().toLowerCase().substring(0, 200),
    ].join("|");
    const cached = ttsCache.get(cacheKey);
    if (cached) {
        console.log("[TTS] Cache HIT for:", text.substring(0, 40));
        return cached;
    }
    const voiceSettings = {
        stability: delivery.stability,
        similarity_boost: delivery.similarityBoost,
        style: delivery.style,
        use_speaker_boost: delivery.speakerBoost,
    };
    /* Only sent when set: some voice/model pairings reject an explicit speed. */
    if (typeof profile.speed === "number")
        voiceSettings.speed = profile.speed;
    /*
     * Try the configured voice, then whatever else would work.
     *
     * Falling back is deliberate, and it is not the same as ignoring the
     * problem: a voice id that ElevenLabs rejects is a settings mistake, and the
     * right response to a settings mistake is to keep talking in a voice that
     * works while saying loudly that the chosen one does not. Going mute serves
     * nobody — least of all the person on the other end of the conversation.
     */
    const attempts = [profile.voiceId, ...(0, voiceProfile_js_1.fallbackVoiceIds)(profile.voiceId)]
        .filter((id, i, all) => id && all.indexOf(id) === i)
        .filter((id, i) => i === 0 || !rejectedVoices.has(id));
    const startedWith = attempts[0];
    let lastStatus = 0;
    let lastDetail = "";
    for (const voiceId of attempts) {
        /* Already known bad this boot — do not pay the round trip again. */
        if (rejectedVoices.has(voiceId))
            continue;
        let res;
        try {
            res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=pcm_${ELEVENLABS_SAMPLE_RATE}`, {
                method: "POST",
                headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/pcm" },
                signal: AbortSignal.timeout(30000),
                body: JSON.stringify({ text, model_id: modelId, voice_settings: voiceSettings }),
            });
        }
        catch (err) {
            lastDetail = err instanceof Error ? err.message : String(err);
            console.error("[hull/tts] ElevenLabs request failed:", lastDetail);
            /* A network failure says nothing about the voice — do not blacklist it,
               and do not burn the fallbacks on what is probably a blip. */
            break;
        }
        if (res.ok) {
            const pcm = Buffer.from(await res.arrayBuffer());
            if (!pcm.length) {
                lastDetail = "empty audio";
                continue;
            }
            const result = { pcm, sampleRate: ELEVENLABS_SAMPLE_RATE };
            if (ttsCache.size >= TTS_CACHE_MAX) {
                const firstKey = ttsCache.keys().next().value;
                if (firstKey)
                    ttsCache.delete(firstKey);
            }
            /* Cache under the voice that actually spoke, so a later fix to the
               setting is not masked by audio rendered in the substitute. */
            ttsCache.set(voiceId === profile.voiceId ? cacheKey : [voiceId, ...cacheKey.split("|").slice(1)].join("|"), result);
            health.lastOk = true;
            health.lastError = null;
            health.lastAt = new Date().toISOString();
            if (voiceId !== startedWith) {
                health.substitutedFrom = startedWith;
                health.substitutedTo = voiceId;
            }
            else {
                health.substitutedFrom = null;
                health.substitutedTo = null;
            }
            return result;
        }
        lastStatus = res.status;
        lastDetail = await res.text().catch(() => "");
        console.error("[hull/tts] ElevenLabs error:", res.status, lastDetail);
        /* A retired or wrong voice id is the one failure worth naming loudly: it is
           silent from the outside — Harvey simply stops speaking — and no other
           symptom points at the voice setting. */
        if (res.status === 404 || /voice.*not.*found/i.test(lastDetail)) {
            rejectedVoices.add(voiceId);
            console.error(`[hull/tts] voice "${voiceId === profile.voiceId ? profile.voiceName : voiceId}" (${voiceId}) ` +
                `was rejected by ElevenLabs. Falling back so Harvey keeps talking — fix it at /api/harvey/voice.`);
            continue; // try the next candidate
        }
        /* Anything else (401, 429, 5xx) is about the account or the service, not
           this voice. Another voice id will fail identically, so stop here. */
        break;
    }
    health.lastOk = false;
    health.lastError = lastStatus
        ? `ElevenLabs ${lastStatus}: ${lastDetail.slice(0, 300)}`
        : lastDetail.slice(0, 300) || "no voice could be reached";
    health.lastAt = new Date().toISOString();
    return null;
}
/** Drop cached audio — called when the voice changes so the next line is fresh. */
function clearTtsCache() {
    ttsCache.clear();
    /* Also forget which voices were rejected: the operator may have just fixed
       the very thing that got one blacklisted, and refusing to try again would
       make the fix look like it did not work. */
    rejectedVoices.clear();
    health.substitutedFrom = null;
    health.substitutedTo = null;
}
