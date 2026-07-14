import path from "path";
import fs from "fs";
import {
  updateVoiceoverRequest,
  getApprovedQueuedRequests,
  getPrimaryReferenceClip,
  getReferenceClipById,
  setReferenceClipVoiceId,
  type ReferenceClip,
} from "../../core/voiceCloneStore.js";
import { generateVoiceover as voxcpmGenerate, isVoxCpmConfigured } from "../../integrations/voxcpm/index.js";
import {
  isElevenLabsConfigured,
  createInstantVoiceClone,
  generateVoiceover as elevenGenerate,
} from "../../integrations/elevenlabsVoice/index.js";
import { checkScriptSafety, requiresApproval } from "./safetyLock.js";

const DATA_ROOT = fs.existsSync("/data")
  ? "/data/voice-clone"
  : path.join(process.cwd(), "data", "voice-clone");
const GENERATED_DIR = path.join(DATA_ROOT, "generated");
const EXPORTS_DIR = path.join(DATA_ROOT, "exports");
fs.mkdirSync(GENERATED_DIR, { recursive: true });
fs.mkdirSync(EXPORTS_DIR, { recursive: true });

/**
 * Ensure an ElevenLabs cloned voice exists for this reference clip, creating
 * one from its audio on first use and persisting the voice_id so later jobs
 * reuse the same clone. Returns the voice_id, or null with the reason logged.
 */
async function ensureClonedVoiceId(clip: ReferenceClip): Promise<{ voiceId: string | null; error?: string }> {
  if (clip.elevenVoiceId) return { voiceId: clip.elevenVoiceId };
  if (!clip.localAudioPath || !fs.existsSync(clip.localAudioPath)) {
    return { voiceId: null, error: "Reference audio file missing on disk" };
  }
  const clone = await createInstantVoiceClone({
    name: `Marco Puga (${(clip.id || "ref").slice(0, 8)})`,
    filePaths: [clip.localAudioPath],
    description: "Marco Puga Realty — cloned voiceover voice",
  });
  if (!clone.success || !clone.voiceId) {
    return { voiceId: null, error: clone.error || "Voice clone creation failed" };
  }
  if (clip.id) setReferenceClipVoiceId(clip.id, clone.voiceId);
  console.log("[VoiceClone] Created ElevenLabs clone", clone.voiceId, "from reference", clip.id);
  return { voiceId: clone.voiceId };
}

export async function processNextVoiceoverJob(): Promise<{ processed: number }> {
  const queued = getApprovedQueuedRequests();
  if (queued.length === 0) return { processed: 0 };

  let processed = 0;

  for (const req of queued) {
    if (!req.id) continue;

    // Safety lock re-runs at generation time — approval is never a bypass.
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
        error: "No primary reference clip configured — upload Marco's voice sample first",
      });
      continue;
    }

    updateVoiceoverRequest(req.id, { generationStatus: "generating" });
    console.log("[VoiceClone] Generating voiceover for request", req.id, "-", req.deliveryStyle);

    let outputPaths: string[] | undefined;
    let error: string | undefined;

    if (isElevenLabsConfigured()) {
      // Primary path: ElevenLabs clone + TTS (works on this CPU-only box).
      const { voiceId, error: cloneErr } = await ensureClonedVoiceId(referenceClip);
      if (!voiceId) {
        error = cloneErr || "Could not obtain a cloned voice";
      } else {
        const result = await elevenGenerate({
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
    } else if (isVoxCpmConfigured()) {
      // Fallback: self-hosted VoxCPM sidecar, if someone stands one up on GPU.
      const result = await voxcpmGenerate({
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
    } else {
      error = "No voice engine configured — set ELEVENLABS_API_KEY";
    }

    if (outputPaths && outputPaths.length > 0) {
      updateVoiceoverRequest(req.id, {
        generationStatus: "complete",
        outputFilePaths: outputPaths,
        exportFilePath: outputPaths[0],
      });
      console.log("[VoiceClone] Complete:", req.id, "-", outputPaths.length, "file(s)");
    } else {
      updateVoiceoverRequest(req.id, {
        generationStatus: "failed",
        error: error || "Unknown generation error",
      });
      console.error("[VoiceClone] Failed:", req.id, "-", error);
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
