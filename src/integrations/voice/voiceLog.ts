/** Harvey voice diagnostics — enable with HARVEY_VOICE_LOG=1 or MARCO_LOG_LEVEL=debug */

export function harveyVoiceLogEnabled(): boolean {
  const v = process.env.HARVEY_VOICE_LOG?.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  const m = process.env.MARCO_LOG_LEVEL?.trim().toLowerCase();
  return m === "debug" || m === "verbose" || m === "2";
}

export function voiceLog(msg: string, data?: Record<string, unknown>): void {
  if (!harveyVoiceLogEnabled()) return;
  if (data && Object.keys(data).length) {
    console.log(`[HarveyVoice] ${msg}`, JSON.stringify(data));
  } else {
    console.log(`[HarveyVoice] ${msg}`);
  }
}
