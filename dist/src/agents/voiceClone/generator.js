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
const safetyLock_js_1 = require("./safetyLock.js");
const EXPORTS_DIR = fs_1.default.existsSync("/data")
    ? "/data/voice-clone/exports"
    : path_1.default.join(process.cwd(), "data", "voice-clone", "exports");
fs_1.default.mkdirSync(EXPORTS_DIR, { recursive: true });
async function processNextVoiceoverJob() {
    const queued = (0, voiceCloneStore_js_1.getApprovedQueuedRequests)();
    if (queued.length === 0)
        return { processed: 0 };
    let processed = 0;
    for (const req of queued) {
        if (!req.id)
            continue;
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
                error: "No primary reference clip configured",
            });
            continue;
        }
        (0, voiceCloneStore_js_1.updateVoiceoverRequest)(req.id, { generationStatus: "generating" });
        console.log("[VoiceClone] Generating voiceover for request", req.id, "-", req.deliveryStyle);
        const result = await (0, index_js_1.generateVoiceover)({
            script: req.script,
            deliveryStyle: req.deliveryStyle,
            customStyleDescription: req.customStyleDescription,
            referenceAudioPath: referenceClip.localAudioPath,
            referenceTranscript: referenceClip.transcript,
            voxcpmMode: req.voxcpmMode || "ultimate",
            hookVariationCount: req.hookVariationCount || 1,
        });
        if (result.success && result.outputPaths && result.outputPaths.length > 0) {
            const exportPath = result.outputPaths[0];
            (0, voiceCloneStore_js_1.updateVoiceoverRequest)(req.id, {
                generationStatus: "complete",
                outputFilePaths: result.outputPaths,
                exportFilePath: exportPath,
            });
            console.log("[VoiceClone] Complete:", req.id, "-", result.outputPaths.length, "file(s)");
        }
        else {
            (0, voiceCloneStore_js_1.updateVoiceoverRequest)(req.id, {
                generationStatus: "failed",
                error: result.error || "Unknown generation error",
            });
            console.error("[VoiceClone] Failed:", req.id, "-", result.error);
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
