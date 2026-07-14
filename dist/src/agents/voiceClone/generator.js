"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processNextVoiceoverJob = processNextVoiceoverJob;
exports.scheduleVoiceoverProcessor = scheduleVoiceoverProcessor;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const voiceCloneStore_js_1 = require("../../core/voiceCloneStore.js");
const index_js_1 = require("../../integrations/voxcpm/index.js");
const index_js_2 = require("../../integrations/elevenlabsVoice/index.js");
const safetyLock_js_1 = require("./safetyLock.js");
const DATA_ROOT = fs_1.default.existsSync("/data")
    ? "/data/voice-clone"
    : path_1.default.join(process.cwd(), "data", "voice-clone");
const GENERATED_DIR = path_1.default.join(DATA_ROOT, "generated");
const EXPORTS_DIR = path_1.default.join(DATA_ROOT, "exports");
fs_1.default.mkdirSync(GENERATED_DIR, { recursive: true });
fs_1.default.mkdirSync(EXPORTS_DIR, { recursive: true });
/**
 * Ensure an ElevenLabs cloned voice exists for this reference clip, creating
 * one from its audio on first use and persisting the voice_id so later jobs
 * reuse the same clone. Returns the voice_id, or null with the reason logged.
 */
async function ensureClonedVoiceId(clip) {
    if (clip.elevenVoiceId)
        return { voiceId: clip.elevenVoiceId };
    if (!clip.localAudioPath || !fs_1.default.existsSync(clip.localAudioPath)) {
        return { voiceId: null, error: "Reference audio file missing on disk" };
    }
    const clone = await (0, index_js_2.createInstantVoiceClone)({
        name: `Marco Puga (${(clip.id || "ref").slice(0, 8)})`,
        filePaths: [clip.localAudioPath],
        description: "Marco Puga Realty — cloned voiceover voice",
    });
    if (!clone.success || !clone.voiceId) {
        return { voiceId: null, error: clone.error || "Voice clone creation failed" };
    }
    if (clip.id)
        (0, voiceCloneStore_js_1.setReferenceClipVoiceId)(clip.id, clone.voiceId);
    console.log("[VoiceClone] Created ElevenLabs clone", clone.voiceId, "from reference", clip.id);
    return { voiceId: clone.voiceId };
}
async function processNextVoiceoverJob() {
    const queued = (0, voiceCloneStore_js_1.getApprovedQueuedRequests)();
    if (queued.length === 0)
        return { processed: 0 };
    let processed = 0;
    for (const req of queued) {
        if (!req.id)
            continue;
        // Safety lock re-runs at generation time — approval is never a bypass.
        const safetyCheck = (0, safetyLock_js_1.checkScriptSafety)(req.script, req.id, req.requestedBy || "unknown");
        if (!safetyCheck.allowed) {
            (0, voiceCloneStore_js_1.updateVoiceoverRequest)(req.id, {
                approvalStatus: "blocked",
                generationStatus: "failed",
                error: `Safety lock: ${safetyCheck.reason}`,
            });
            console.warn("[VoiceClone] Safety lock blocked approved request", req.id, "-", safetyCheck.reason);
            continue;
        }
        if ((0, safetyLock_js_1.requiresApproval)(req.approvalStatus)) {
            console.warn("[VoiceClone] Request not approved — skipping", req.id);
            continue;
        }
        const referenceClip = req.referenceClipId
            ? (0, voiceCloneStore_js_1.getReferenceClipById)(req.referenceClipId)
            : (0, voiceCloneStore_js_1.getPrimaryReferenceClip)();
        if (!referenceClip?.localAudioPath) {
            (0, voiceCloneStore_js_1.updateVoiceoverRequest)(req.id, {
                generationStatus: "failed",
                error: "No primary reference clip configured — upload Marco's voice sample first",
            });
            continue;
        }
        (0, voiceCloneStore_js_1.updateVoiceoverRequest)(req.id, { generationStatus: "generating" });
        console.log("[VoiceClone] Generating voiceover for request", req.id, "-", req.deliveryStyle);
        let outputPaths;
        let error;
        if ((0, index_js_2.isElevenLabsConfigured)()) {
            // Primary path: ElevenLabs clone + TTS (works on this CPU-only box).
            const { voiceId, error: cloneErr } = await ensureClonedVoiceId(referenceClip);
            if (!voiceId) {
                error = cloneErr || "Could not obtain a cloned voice";
            }
            else {
                const result = await (0, index_js_2.generateVoiceover)({
                    voiceId,
                    script: req.script,
                    deliveryStyle: req.deliveryStyle,
                    hookVariationCount: req.hookVariationCount || 1,
                    outputDir: GENERATED_DIR,
                    filePrefix: req.id,
                });
                outputPaths = result.outputPaths;
                error = result.error;
            }
        }
        else if ((0, index_js_1.isVoxCpmConfigured)()) {
            // Fallback: self-hosted VoxCPM sidecar, if someone stands one up on GPU.
            const result = await (0, index_js_1.generateVoiceover)({
                script: req.script,
                deliveryStyle: req.deliveryStyle,
                customStyleDescription: req.customStyleDescription,
                referenceAudioPath: referenceClip.localAudioPath,
                referenceTranscript: referenceClip.transcript,
                voxcpmMode: req.voxcpmMode || "ultimate",
                hookVariationCount: req.hookVariationCount || 1,
            });
            outputPaths = result.outputPaths;
            error = result.error;
        }
        else {
            error = "No voice engine configured — set ELEVENLABS_API_KEY";
        }
        if (outputPaths && outputPaths.length > 0) {
            (0, voiceCloneStore_js_1.updateVoiceoverRequest)(req.id, {
                generationStatus: "complete",
                outputFilePaths: outputPaths,
                exportFilePath: outputPaths[0],
            });
            console.log("[VoiceClone] Complete:", req.id, "-", outputPaths.length, "file(s)");
        }
        else {
            (0, voiceCloneStore_js_1.updateVoiceoverRequest)(req.id, {
                generationStatus: "failed",
                error: error || "Unknown generation error",
            });
            console.error("[VoiceClone] Failed:", req.id, "-", error);
        }
        processed++;
    }
    return { processed };
}
function scheduleVoiceoverProcessor() {
    setInterval(() => {
        processNextVoiceoverJob().catch((err) => console.error("[VoiceClone]", err));
    }, 30 * 1000);
    console.log("[VoiceClone] Job processor scheduled — polling every 30s");
}
