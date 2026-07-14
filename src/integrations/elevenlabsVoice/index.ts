/**
 * ElevenLabs voice-clone backend for the Voice Clone feature.
 *
 * The production box is CPU-only (Fly performance-2x, 4GB, no GPU) with a hard
 * image-size ceiling, so the self-hosted VoxCPM neural model that the feature
 * was originally wired to (src/integrations/voxcpm) can never run here — it
 * silently falls back to a mock sine wave. ElevenLabs is already the app's
 * audio vendor (STT proxy + Harvey TTS, ELEVENLABS_API_KEY) and offers a
 * first-class voice-cloning API, so all the heavy lifting happens in their
 * cloud and this box only orchestrates.
 *
 * Two capabilities:
 *   1. createInstantVoiceClone() — POST /v1/voices/add with Marco's reference
 *      audio → a persistent ElevenLabs voice_id (the "clone").
 *   2. generateVoiceover() — POST /v1/text-to-speech/{voice_id} per hook
 *      variation, writing real MP3s to disk. Same result shape the VoxCPM
 *      integration returned, so the job queue / store / UI are untouched.
 *
 * Everything is best-effort and returns a structured error rather than
 * throwing, so a misconfigured key or an unsupported plan surfaces a clear
 * message instead of crashing the generation worker.
 */
import fs from "fs";
import path from "path";

const API_BASE = "https://api.elevenlabs.io/v1";

// Quality-first model for produced voiceovers (env-overridable). turbo/flash
// are faster but lower fidelity — content voiceovers favour quality.
const VOICE_MODEL_ID = process.env.ELEVENLABS_VOICE_MODEL_ID?.trim() || "eleven_multilingual_v2";
// 128kbps 44.1kHz MP3: browser-playable, download-friendly, plan-safe (192k
// needs Creator tier). Override with ELEVENLABS_VOICE_OUTPUT_FORMAT if desired.
const OUTPUT_FORMAT = process.env.ELEVENLABS_VOICE_OUTPUT_FORMAT?.trim() || "mp3_44100_128";

export type DeliveryStyle = "energetic_hook" | "calm_explainer" | "warm_client" | "custom";

interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
}

// Delivery style → ElevenLabs voice_settings. Lower stability = more emotional
// range/energy; higher style = more expressive delivery; similarity_boost kept
// high so every read still sounds like Marco.
const DELIVERY_PRESETS: Record<DeliveryStyle, VoiceSettings> = {
  energetic_hook: { stability: 0.3, similarity_boost: 0.85, style: 0.55, use_speaker_boost: true },
  calm_explainer: { stability: 0.65, similarity_boost: 0.85, style: 0.15, use_speaker_boost: true },
  warm_client: { stability: 0.55, similarity_boost: 0.9, style: 0.25, use_speaker_boost: true },
  custom: { stability: 0.5, similarity_boost: 0.85, style: 0.3, use_speaker_boost: true },
};

export function isElevenLabsConfigured(): boolean {
  return !!process.env.ELEVENLABS_API_KEY?.trim();
}

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new Error("ELEVENLABS_API_KEY not configured");
  return key;
}

function audioMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a" || ext === ".mp4") return "audio/mp4";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".flac") return "audio/flac";
  if (ext === ".webm") return "audio/webm";
  return "audio/wav";
}

export interface CloneResult {
  success: boolean;
  voiceId?: string;
  requiresVerification?: boolean;
  error?: string;
}

/**
 * Create an Instant Voice Clone from one or more reference audio files.
 * Returns the ElevenLabs voice_id to persist and reuse for every generation.
 */
export async function createInstantVoiceClone(params: {
  name: string;
  filePaths: string[];
  description?: string;
}): Promise<CloneResult> {
  if (!isElevenLabsConfigured()) {
    return { success: false, error: "ELEVENLABS_API_KEY not configured" };
  }
  const usable = params.filePaths.filter((p) => p && fs.existsSync(p));
  if (usable.length === 0) {
    return { success: false, error: "No reference audio file found on disk" };
  }

  try {
    const form = new FormData();
    form.append("name", params.name);
    if (params.description) form.append("description", params.description);
    // Let ElevenLabs strip room noise from the reference so the clone is clean.
    form.append("remove_background_noise", "true");
    for (const fp of usable) {
      const buf = await fs.promises.readFile(fp);
      form.append("files", new Blob([buf], { type: audioMime(fp) }), path.basename(fp));
    }

    const res = await fetch(`${API_BASE}/voices/add`, {
      method: "POST",
      headers: { "xi-api-key": apiKey() },
      body: form,
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { success: false, error: `ElevenLabs clone failed (${res.status}): ${detail.slice(0, 300)}` };
    }
    const data = (await res.json()) as { voice_id?: string; requires_verification?: boolean };
    if (!data.voice_id) {
      return { success: false, error: "ElevenLabs returned no voice_id" };
    }
    return {
      success: true,
      voiceId: data.voice_id,
      requiresVerification: !!data.requires_verification,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface GenerateParams {
  voiceId: string;
  script: string;
  deliveryStyle: DeliveryStyle;
  hookVariationCount?: number;
  outputDir: string;
  filePrefix: string;
}

export interface GenerateResult {
  success: boolean;
  outputPaths?: string[];
  error?: string;
}

/**
 * Synthesize the script in Marco's cloned voice, once per requested hook
 * variation. Each variation nudges stability so multiple takes read
 * differently instead of being byte-identical. Writes MP3s to outputDir and
 * returns their absolute paths (which the store maps to /voice-clone-files/…).
 */
export async function generateVoiceover(params: GenerateParams): Promise<GenerateResult> {
  if (!isElevenLabsConfigured()) {
    return { success: false, error: "ELEVENLABS_API_KEY not configured" };
  }
  if (!params.voiceId) return { success: false, error: "No cloned voice_id available" };
  if (!params.script.trim()) return { success: false, error: "Empty script" };

  const base = DELIVERY_PRESETS[params.deliveryStyle] || DELIVERY_PRESETS.custom;
  const count = Math.max(1, Math.min(5, params.hookVariationCount || 1));
  fs.mkdirSync(params.outputDir, { recursive: true });

  const outputPaths: string[] = [];
  try {
    for (let i = 0; i < count; i++) {
      // Spread stability around the preset for distinct takes (clamped 0..1).
      const jitter = count > 1 ? (i - (count - 1) / 2) * 0.12 : 0;
      const settings: VoiceSettings = {
        ...base,
        stability: Math.max(0, Math.min(1, base.stability + jitter)),
      };

      const url = `${API_BASE}/text-to-speech/${encodeURIComponent(
        params.voiceId,
      )}?output_format=${OUTPUT_FORMAT}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey(),
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        signal: AbortSignal.timeout(120000),
        body: JSON.stringify({
          text: params.script,
          model_id: VOICE_MODEL_ID,
          voice_settings: settings,
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return {
          success: false,
          error: `ElevenLabs TTS failed (${res.status}): ${detail.slice(0, 300)}`,
        };
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return { success: false, error: "ElevenLabs returned empty audio" };
      const suffix = count > 1 ? `_v${i + 1}` : "";
      const outPath = path.join(params.outputDir, `${params.filePrefix}${suffix}.mp3`);
      await fs.promises.writeFile(outPath, buf);
      outputPaths.push(outPath);
    }
    return { success: true, outputPaths };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ElevenHealth {
  ok: boolean;
  tier?: string;
  canCloneVoices?: boolean;
  error?: string;
}

/** Confirm the key works and whether the plan permits voice cloning. */
export async function checkElevenLabsHealth(): Promise<ElevenHealth | null> {
  if (!isElevenLabsConfigured()) return null;
  try {
    const res = await fetch(`${API_BASE}/user/subscription`, {
      headers: { "xi-api-key": apiKey() },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { ok: false, error: `subscription check ${res.status}` };
    }
    const data = (await res.json()) as {
      tier?: string;
      can_use_instant_voice_cloning?: boolean;
      voice_limit?: number;
    };
    return {
      ok: true,
      tier: data.tier,
      // Free tier cannot clone; surface it so the UI can warn instead of failing silently.
      canCloneVoices: data.can_use_instant_voice_cloning ?? (data.tier ? data.tier !== "free" : undefined),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
