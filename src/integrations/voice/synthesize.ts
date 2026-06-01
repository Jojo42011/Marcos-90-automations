import { sanitizeSpeech } from "./sanitizeSpeech.js";

export function isElevenLabsConfigured(): boolean {
  return Boolean(
    process.env.ELEVENLABS_API_KEY?.trim() && process.env.ELEVENLABS_VOICE_ID?.trim(),
  );
}

export function isDeepgramTtsConfigured(): boolean {
  return Boolean(process.env.DEEPGRAM_API_KEY?.trim());
}

export function getTtsProvider(): "elevenlabs" | "deepgram" | "none" {
  const forced = process.env.TTS_PROVIDER?.trim().toLowerCase();
  if (forced === "deepgram" && isDeepgramTtsConfigured()) return "deepgram";
  if (forced === "elevenlabs" && isElevenLabsConfigured()) return "elevenlabs";
  if (isElevenLabsConfigured()) return "elevenlabs";
  if (isDeepgramTtsConfigured()) return "deepgram";
  return "none";
}

async function elevenLabsMp3(text: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY!.trim();
  const voiceId = process.env.ELEVENLABS_VOICE_ID!.trim();
  const modelId =
    process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_turbo_v2_5";
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({ text, model_id: modelId }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`ElevenLabs TTS ${res.status}: ${err.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function deepgramAuraMp3(text: string): Promise<Buffer> {
  const apiKey = process.env.DEEPGRAM_API_KEY!.trim();
  const model =
    process.env.DEEPGRAM_VOICE?.trim() || "aura-2-orion-en";
  const url = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Deepgram TTS ${res.status}: ${err.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function synthesizeSpeech(rawText: string): Promise<Buffer> {
  const text = sanitizeSpeech(rawText);
  if (!text) throw new Error("Empty speech text");
  const provider = getTtsProvider();
  if (provider === "elevenlabs") return elevenLabsMp3(text);
  if (provider === "deepgram") return deepgramAuraMp3(text);
  throw new Error("TTS not configured (set ELEVENLABS_* or DEEPGRAM_API_KEY)");
}
