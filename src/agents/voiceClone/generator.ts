import path from "path";
import fs from "fs";
import {
  getVoiceoverRequest,
  updateVoiceoverRequest,
  getApprovedQueuedRequests,
  getPrimaryReferenceClip,
  getReferenceClipById,
} from "../../core/voiceCloneStore.js";
import { generateVoiceover } from "../../integrations/voxcpm/index.js";
import { checkScriptSafety, requiresApproval } from "./safetyLock.js";

const EXPORTS_DIR = fs.existsSync("/data")
  ? "/data/voice-clone/exports"
  : path.join(process.cwd(), "data", "voice-clone", "exports");

fs.mkdirSync(EXPORTS_DIR, { recursive: true });

export async function processNextVoiceoverJob(): Promise<{ processed: number }> {
  const queued = getApprovedQueuedRequests();
  if (queued.length === 0) return { processed: 0 };

  let processed = 0;

  for (const req of queued) {
    if (!req.id) continue;

    const safetyCheck = checkScriptSafety(req.script, req.id, req.requestedBy || "unknown");
    if (!safetyCheck.allowed) {
      updateVoiceoverRequest(req.id, {
        approvalStatus: "blocked",
        generationStatus: "failed",
        error: `Safety lock: ${safetyCheck.reason}`,
      });
      console.warn("[VoiceClone] Safety lock blocked approved request", req.id, "-", safetyCheck.reason);
      continue;
    }

    if (requiresApproval(req.approvalStatus)) {
      console.warn("[VoiceClone] Request not approved — skipping", req.id);
      continue;
    }

    const referenceClip = req.referenceClipId
      ? getReferenceClipById(req.referenceClipId)
      : getPrimaryReferenceClip();

    if (!referenceClip?.localAudioPath) {
      updateVoiceoverRequest(req.id, {
        generationStatus: "failed",
        error: "No primary reference clip configured",
      });
      continue;
    }

    updateVoiceoverRequest(req.id, { generationStatus: "generating" });
    console.log("[VoiceClone] Generating voiceover for request", req.id, "-", req.deliveryStyle);

    const result = await generateVoiceover({
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

      updateVoiceoverRequest(req.id, {
        generationStatus: "complete",
        outputFilePaths: result.outputPaths,
        exportFilePath: exportPath,
      });

      console.log("[VoiceClone] Complete:", req.id, "-", result.outputPaths.length, "file(s)");
    } else {
      updateVoiceoverRequest(req.id, {
        generationStatus: "failed",
        error: result.error || "Unknown generation error",
      });
      console.error("[VoiceClone] Failed:", req.id, "-", result.error);
    }

    processed++;
  }

  return { processed };
}

export function scheduleVoiceoverProcessor(): void {
  setInterval(() => {
    processNextVoiceoverJob().catch((err) => console.error("[VoiceClone]", err));
  }, 30 * 1000);

  console.log("[VoiceClone] Job processor scheduled — polling every 30s");
}
