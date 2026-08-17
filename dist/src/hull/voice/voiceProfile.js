"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_VOICE = exports.RECOMMENDED_VOICES = exports.DEFAULT_PRESET = exports.DELIVERY_PRESETS = void 0;
exports.getVoiceProfile = getVoiceProfile;
exports.effectiveDelivery = effectiveDelivery;
exports.setVoiceProfile = setVoiceProfile;
exports.clearVoiceProfileCache = clearVoiceProfileCache;
/**
 * Harvey's speaking voice: which voice, and how it delivers.
 *
 * WHY THIS IS A STORED SETTING AND NOT JUST AN ENV VAR. `ELEVENLABS_VOICE_ID`
 * is deployed as a Fly secret, so changing a default in this file would be
 * silently overridden in production and the voice would appear not to change at
 * all. The stored setting therefore takes precedence over the environment, and
 * the environment over the built-in default. That also means picking a new
 * voice is a click, not a deploy — which matters, because "does this one sound
 * right?" is a question you answer by listening, several times.
 *
 * WHY THE MODEL DOES NOT CHANGE. Harvey talks in a live conversation, so the
 * temptation is to reach for ElevenLabs' best model — but Eleven v3, their most
 * natural, explicitly cannot run in real time; ElevenLabs' own guidance is to
 * stay on Flash v2.5 for conversational use. The quality gain there is bought
 * with latency Harvey does not have. So the model stays, and the improvement
 * comes from the two levers that cost nothing:
 *
 *   1. the VOICE — the old default was Rachel (21m00Tcm4TlvDq8ikWAM), the
 *      oldest stock voice on the platform and noticeably thin by 2026
 *   2. the SETTINGS — the previous request sent NO voice_settings at all, so
 *      every generation used bare defaults. Stability in particular is what
 *      separates a calm, even assistant from one that wanders in tone.
 */
const fs_1 = require("fs");
const path_1 = require("path");
/**
 * Named delivery presets, so the choice is "how should Harvey sound" rather
 * than four numbers nobody remembers the meaning of.
 */
exports.DELIVERY_PRESETS = {
    soothing: {
        label: "Soothing",
        note: "Calm, even and unhurried. Holds one tone — the register you want from an assistant that talks all day.",
        delivery: { stability: 0.72, similarityBoost: 0.85, style: 0.0, speakerBoost: true },
    },
    natural: {
        label: "Natural",
        note: "Balanced. Some warmth and movement without drifting.",
        delivery: { stability: 0.55, similarityBoost: 0.8, style: 0.0, speakerBoost: true },
    },
    expressive: {
        label: "Expressive",
        note: "More emotional range. Livelier, but less predictable line to line.",
        delivery: { stability: 0.38, similarityBoost: 0.75, style: 0.15, speakerBoost: true },
    },
};
exports.DEFAULT_PRESET = "soothing";
exports.RECOMMENDED_VOICES = [
    { name: "Sarah", id: "EXAVITQu4vr4xnSDxMaL", note: "Soft, warm, unhurried American. The closest to a calm personal assistant." },
    { name: "Lily", id: "pFZP5JQG7iQjIQuC4Bku", note: "Warm British, gentle and clear." },
    { name: "Charlotte", id: "XB0fDUnXU5powFXDhCwa", note: "Low, smooth, measured." },
    { name: "Matilda", id: "XrExE9yKIg1WjnnlVkGX", note: "Friendly and even, a little brighter." },
    { name: "Brian", id: "nPczCjzI2devNBz1zQrb", note: "Deep, calm American male. Reassuring rather than commanding." },
    { name: "George", id: "JBFqnCBsd6RMkjVDRZzb", note: "Warm, mature British male. Narrator-steady." },
    { name: "Daniel", id: "onwK4e9ZLuTAKqWW03F9", note: "Composed British male, news-reader neutral." },
];
/** Where Harvey lands when nothing has been chosen yet. */
exports.DEFAULT_VOICE = exports.RECOMMENDED_VOICES[0];
function resolvePath() {
    const env = process.env.VOICE_PROFILE_PATH?.trim();
    if (env)
        return env;
    const flyDb = "/data/db.json";
    const localDb = (0, path_1.join)(process.cwd(), "data", "local-dashboard-db.json");
    const base = process.env.DB_JSON_PATH?.trim() || ((0, fs_1.existsSync)(flyDb) ? flyDb : localDb);
    return (0, path_1.join)((0, path_1.dirname)(base), "voice-profile.json");
}
let cache = null;
function getVoiceProfile() {
    if (cache)
        return cache;
    const path = resolvePath();
    let stored = {};
    try {
        if ((0, fs_1.existsSync)(path))
            stored = JSON.parse((0, fs_1.readFileSync)(path, "utf8"));
    }
    catch {
        /* A corrupt settings file must not take Harvey's voice out entirely. */
        stored = {};
    }
    /* Stored > env > built-in default. The env rung exists so an operator can
       still pin a voice from Fly secrets if they prefer. */
    const envId = process.env.ELEVENLABS_VOICE_ID?.trim();
    const voiceId = stored.voiceId?.trim() || envId || exports.DEFAULT_VOICE.id;
    const known = exports.RECOMMENDED_VOICES.find((v) => v.id === voiceId);
    cache = {
        voiceId,
        voiceName: stored.voiceName?.trim() || known?.name || (envId && envId === voiceId ? "Set by ELEVENLABS_VOICE_ID" : exports.DEFAULT_VOICE.name),
        preset: stored.preset && exports.DELIVERY_PRESETS[stored.preset] ? stored.preset : exports.DEFAULT_PRESET,
        delivery: stored.delivery,
        speed: typeof stored.speed === "number" ? stored.speed : undefined,
        updatedAt: stored.updatedAt,
        updatedBy: stored.updatedBy,
    };
    return cache;
}
/** The four numbers actually sent, preset or hand-tuned. */
function effectiveDelivery(p = getVoiceProfile()) {
    if (p.delivery)
        return p.delivery;
    return (exports.DELIVERY_PRESETS[p.preset] || exports.DELIVERY_PRESETS[exports.DEFAULT_PRESET]).delivery;
}
const clamp01 = (n, fallback) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
};
function setVoiceProfile(patch, updatedBy) {
    const current = getVoiceProfile();
    const next = { ...current };
    if (typeof patch.voiceId === "string" && patch.voiceId.trim()) {
        next.voiceId = patch.voiceId.trim();
        const known = exports.RECOMMENDED_VOICES.find((v) => v.id === next.voiceId);
        next.voiceName = (typeof patch.voiceName === "string" && patch.voiceName.trim()) || known?.name || next.voiceId;
    }
    else if (typeof patch.voiceName === "string" && patch.voiceName.trim()) {
        next.voiceName = patch.voiceName.trim();
    }
    if (typeof patch.preset === "string" && exports.DELIVERY_PRESETS[patch.preset]) {
        next.preset = patch.preset;
        /* Choosing a preset clears a hand-tune, or the preset would appear to do
           nothing while the old numbers kept winning. */
        next.delivery = undefined;
    }
    if (patch.delivery && typeof patch.delivery === "object") {
        const d = patch.delivery;
        const base = effectiveDelivery(next);
        next.delivery = {
            stability: clamp01(d.stability, base.stability),
            similarityBoost: clamp01(d.similarityBoost, base.similarityBoost),
            style: clamp01(d.style, base.style),
            speakerBoost: typeof d.speakerBoost === "boolean" ? d.speakerBoost : base.speakerBoost,
        };
    }
    if ("speed" in patch) {
        const s = Number(patch.speed);
        next.speed = Number.isFinite(s) ? Math.min(1.2, Math.max(0.7, s)) : undefined;
    }
    next.updatedAt = new Date().toISOString();
    if (updatedBy)
        next.updatedBy = updatedBy;
    const path = resolvePath();
    (0, fs_1.mkdirSync)((0, path_1.dirname)(path), { recursive: true });
    (0, fs_1.writeFileSync)(path, JSON.stringify(next, null, 2));
    cache = next;
    return next;
}
/** Test hook — the file is read once and cached for the process. */
function clearVoiceProfileCache() {
    cache = null;
}
