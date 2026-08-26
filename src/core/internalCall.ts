/**
 * The in-process credential Harvey uses to call this server's own CRM API.
 *
 * WHY THIS EXISTS. Harvey's CRM tools used to be hand-written wrappers around
 * store functions, which meant every CRM feature had to be implemented twice —
 * once for the dashboard's HTTP route, once for Harvey — and the two drifted.
 * Giving Harvey "the whole CRM" by writing sixty more wrappers would have made
 * that worse. Instead Harvey calls the same endpoints the CRM page calls, so
 * there is exactly one implementation of "archive a lead" and Harvey cannot
 * fall behind it.
 *
 * WHY IT IS NOT JUST A HEADER. Those endpoints are behind the site lock, and
 * they should stay there. This is a random 32-byte value minted at boot and
 * held only in this process's memory: never written to disk, never logged,
 * never sent to a browser, gone on restart. A request can only carry it if it
 * was made by code running inside this process. Requests still have to arrive
 * over loopback as well — belt and braces, so a proxy misconfiguration that
 * forwarded the header from outside would not be enough on its own.
 *
 * The value is deliberately NOT an env var. An env var can be read by anything
 * on the machine, ends up in `fly ssh console -C env`, and would survive as a
 * static secret; this cannot outlive the process that minted it.
 */
import { randomBytes } from "crypto";
import type { IncomingMessage } from "http";

export const INTERNAL_CALL_HEADER = "x-internal-call";

/** Minted once, at module load. Never leaves the process. */
const INTERNAL_CALL_TOKEN = randomBytes(32).toString("hex");

/** The header pair to attach to an internal fetch. */
export function internalCallHeaders(): Record<string, string> {
  return { [INTERNAL_CALL_HEADER]: INTERNAL_CALL_TOKEN };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True only for a loopback request carrying this process's own token. */
export function isInternalCall(req: IncomingMessage | { headers: Record<string, unknown>; socket?: { remoteAddress?: string } }): boolean {
  const raw = (req.headers as Record<string, unknown>)[INTERNAL_CALL_HEADER];
  const token = typeof raw === "string" ? raw : "";
  if (!token || !timingSafeEqualStr(token, INTERNAL_CALL_TOKEN)) return false;
  /* `trust proxy` rewrites req.ip from X-Forwarded-For, which an outside
     caller controls. The raw socket address cannot be spoofed that way, so the
     loopback check reads the socket directly. */
  const addr = (req as IncomingMessage).socket?.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
