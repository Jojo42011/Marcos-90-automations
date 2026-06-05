/** Harvey voice logging stub — Gemini Live replaced Deepgram/ElevenLabs pipeline. */

export function harveyVoiceLogEnabled(): boolean {
  return false;
}

export function voiceLog(_msg: string, _data?: Record<string, unknown>): void {
  /* no-op */
}
