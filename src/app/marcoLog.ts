import { createHash, randomUUID } from "crypto";

/**
 * Fly-friendly JSON logs: one line per event, grep `marco":true` or `event":"`.
 *
 * MARCO_LOG_LEVEL:
 * - info (default): inbound/outcome, funnel flags, timings, reply previews
 * - debug: + full coaching notes, raw webhook body flag, more LLM step detail
 * - off: suppress structured marco logs (errors still use console.warn)
 */
export type MarcoLogLevel = "off" | "info" | "debug";

export function getMarcoLogLevel(): MarcoLogLevel {
  const v = process.env.MARCO_LOG_LEVEL?.trim().toLowerCase();
  if (!v || v === "info" || v === "1" || v === "true") return "info";
  if (v === "off" || v === "0" || v === "false" || v === "none") return "off";
  if (v === "debug" || v === "verbose" || v === "2") return "debug";
  return "info";
}

/** Stable pseudonymous id for correlating turns without logging raw subscriber ids. */
export function marcoCorrelationId(platform: string, userId: string): string {
  return createHash("sha256")
    .update(`${platform}::${userId}`)
    .digest("hex")
    .slice(0, 12);
}

export function newMarcoRequestId(): string {
  return randomUUID();
}

/** Single-line preview for logs (not full PII dump). */
export function previewText(s: string | null | undefined, max = 200): string {
  if (s == null || s === "") return "";
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

export interface MarcoLogContext {
  requestId: string;
  correlationId: string;
}

export function marcoLog(event: string, fields: Record<string, unknown>): void {
  if (getMarcoLogLevel() === "off") return;
  console.log(
    JSON.stringify({
      marco: true,
      ts: new Date().toISOString(),
      event,
      ...fields,
    }),
  );
}

export function marcoLogDebug(event: string, fields: Record<string, unknown>): void {
  if (getMarcoLogLevel() !== "debug") return;
  marcoLog(event, { ...fields, _level: "debug" });
}
