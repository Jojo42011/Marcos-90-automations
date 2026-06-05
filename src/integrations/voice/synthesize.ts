/** TTS removed — Harvey voice uses Gemini Live / Gemini TTS. */

export function getTtsProvider(): "none" {
  return "none";
}

export async function synthesizeSpeech(_rawText: string): Promise<Buffer> {
  throw new Error("Legacy TTS removed — use POST /api/jarvis/gemini-tts");
}
