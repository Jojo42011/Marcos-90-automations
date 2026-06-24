import axios from "axios";

function getVoxCpmBaseUrl(): string {
  const url = process.env.VOXCPM_API_URL;
  if (!url) throw new Error("VOXCPM_API_URL not configured");
  return url.replace(/\/$/, "");
}

export function isVoxCpmConfigured(): boolean {
  return !!process.env.VOXCPM_API_URL?.trim();
}

export interface VoxCpmGenerateParams {
  script: string;
  deliveryStyle: "energetic_hook" | "calm_explainer" | "warm_client" | "custom";
  customStyleDescription?: string;
  referenceAudioPath: string;
  referenceTranscript?: string;
  voxcpmMode?: "controllable" | "ultimate";
  hookVariationCount?: number;
}

export interface VoxCpmGenerateResult {
  success: boolean;
  outputPaths?: string[];
  durationSeconds?: number[];
  error?: string;
}

export async function generateVoiceover(params: VoxCpmGenerateParams): Promise<VoxCpmGenerateResult> {
  if (!isVoxCpmConfigured()) {
    console.warn("[VoxCPM] VOXCPM_API_URL not set — cannot generate");
    return { success: false, error: "VoxCPM service not configured" };
  }

  try {
    const response = await axios.post(
      `${getVoxCpmBaseUrl()}/generate`,
      {
        script: params.script,
        delivery_style: params.deliveryStyle,
        custom_style_description: params.customStyleDescription,
        reference_audio_path: params.referenceAudioPath,
        reference_transcript: params.referenceTranscript,
        voxcpm_mode: params.voxcpmMode || "ultimate",
        hook_variation_count: params.hookVariationCount || 1,
      },
      { timeout: 300000 },
    );

    return {
      success: response.data.success,
      outputPaths: response.data.output_paths,
      durationSeconds: response.data.duration_seconds,
      error: response.data.error,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[VoxCPM] Generation error:", message);
    return { success: false, error: message };
  }
}

export async function checkVoxCpmHealth(): Promise<{
  ok: boolean;
  modelLoaded: boolean;
  cudaAvailable: boolean;
} | null> {
  if (!isVoxCpmConfigured()) return null;
  try {
    const response = await axios.get(`${getVoxCpmBaseUrl()}/health`, { timeout: 5000 });
    return {
      ok: response.data.status === "ok",
      modelLoaded: response.data.model_loaded,
      cudaAvailable: response.data.cuda_available,
    };
  } catch {
    return { ok: false, modelLoaded: false, cudaAvailable: false };
  }
}
