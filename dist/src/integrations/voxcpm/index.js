"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isVoxCpmConfigured = isVoxCpmConfigured;
exports.generateVoiceover = generateVoiceover;
exports.checkVoxCpmHealth = checkVoxCpmHealth;
const axios_1 = __importDefault(require("axios"));
function getVoxCpmBaseUrl() {
    const url = process.env.VOXCPM_API_URL;
    if (!url)
        throw new Error("VOXCPM_API_URL not configured");
    return url.replace(/\/$/, "");
}
function isVoxCpmConfigured() {
    return !!process.env.VOXCPM_API_URL?.trim();
}
async function generateVoiceover(params) {
    if (!isVoxCpmConfigured()) {
        console.warn("[VoxCPM] VOXCPM_API_URL not set — cannot generate");
        return { success: false, error: "VoxCPM service not configured" };
    }
    try {
        const response = await axios_1.default.post(`${getVoxCpmBaseUrl()}/generate`, {
            script: params.script,
            delivery_style: params.deliveryStyle,
            custom_style_description: params.customStyleDescription,
            reference_audio_path: params.referenceAudioPath,
            reference_transcript: params.referenceTranscript,
            voxcpm_mode: params.voxcpmMode || "ultimate",
            hook_variation_count: params.hookVariationCount || 1,
        }, { timeout: 300000 });
        return {
            success: response.data.success,
            outputPaths: response.data.output_paths,
            durationSeconds: response.data.duration_seconds,
            error: response.data.error,
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[VoxCPM] Generation error:", message);
        return { success: false, error: message };
    }
}
async function checkVoxCpmHealth() {
    if (!isVoxCpmConfigured())
        return null;
    try {
        const response = await axios_1.default.get(`${getVoxCpmBaseUrl()}/health`, { timeout: 5000 });
        return {
            ok: response.data.status === "ok",
            modelLoaded: response.data.model_loaded,
            cudaAvailable: response.data.cuda_available,
        };
    }
    catch {
        return { ok: false, modelLoaded: false, cudaAvailable: false };
    }
}
