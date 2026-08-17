import { sanitizeForSpeech } from "./speakNumbers.js";
import { effectiveDelivery, getVoiceProfile } from "./voiceProfile.js";

const ttsCache = new Map<string, { pcm: Buffer; sampleRate: number }>();
const TTS_CACHE_MAX = 50;

/** ElevenLabs returns raw S16LE PCM when output_format=pcm_24000 — matches the client's Int16 decoder. */
const ELEVENLABS_SAMPLE_RATE = 24000;

/**
 * Flash v2.5 stays, deliberately. Harvey speaks inside a live conversation and
 * ElevenLabs' own guidance is that their more natural v3 model cannot run in
 * real time — its richness is bought with latency Harvey does not have. The
 * warmth comes from the voice and the delivery settings instead.
 */
const DEFAULT_MODEL = "eleven_flash_v2_5";

export async function generateTTS(rawText: string): Promise<{ pcm: Buffer; sampleRate: number } | null> {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key || !rawText.trim()) return null;

  /* Ear-text, not eye-text (playbook §6.2): "$40k" and "(210) 718-3874" come
     out of a low-latency TTS model flat or mangled, so numbers become words
     HERE, at the mouth — the UI keeps the readable form. */
  const text = sanitizeForSpeech(rawText);
  if (!text.trim()) return null;

  const profile = getVoiceProfile();
  const delivery = effectiveDelivery(profile);
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

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
    profile.voiceId,
  )}?output_format=pcm_${ELEVENLABS_SAMPLE_RATE}`;

  const voiceSettings: Record<string, unknown> = {
    stability: delivery.stability,
    similarity_boost: delivery.similarityBoost,
    style: delivery.style,
    use_speaker_boost: delivery.speakerBoost,
  };
  /* Only sent when set: some voice/model pairings reject an explicit speed. */
  if (typeof profile.speed === "number") voiceSettings.speed = profile.speed;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/pcm",
      },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: voiceSettings,
      }),
    });
  } catch (err) {
    console.error("[hull/tts] ElevenLabs request failed:", err instanceof Error ? err.message : err);
    return null;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[hull/tts] ElevenLabs error:", res.status, detail);
    /* A retired or wrong voice id is the one failure worth naming loudly: it is
       silent from the outside — Harvey simply stops speaking — and no other
       symptom points at the voice setting. */
    if (res.status === 404 || /voice.*not.*found/i.test(detail)) {
      console.error(
        `[hull/tts] voice "${profile.voiceName}" (${profile.voiceId}) was rejected by ElevenLabs. ` +
        `Pick another at /api/harvey/voice — Harvey has no voice until this resolves.`,
      );
    }
    return null;
  }

  const pcm = Buffer.from(await res.arrayBuffer());
  if (!pcm.length) return null;

  const result = { pcm, sampleRate: ELEVENLABS_SAMPLE_RATE };
  if (ttsCache.size >= TTS_CACHE_MAX) {
    const firstKey = ttsCache.keys().next().value;
    if (firstKey) ttsCache.delete(firstKey);
  }
  ttsCache.set(cacheKey, result);
  console.log("[TTS] Cached result for:", text.substring(0, 40), "— cache size:", ttsCache.size);

  return result;
}

/** Drop cached audio — called when the voice changes so the next line is fresh. */
export function clearTtsCache(): void {
  ttsCache.clear();
}
