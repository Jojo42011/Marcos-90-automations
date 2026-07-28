/**
 * 1.2 — Browser control bus.
 *
 * Lets Harvey drive a real browser: navigate, click, fill forms, pull data
 * off pages that have no API (a listing portal, a title company's form, an
 * MLS back office). The extension does the driving; this module is the queue
 * between Harvey and it.
 *
 * Why a queue and not a socket: the server cannot reach into a browser, so
 * the extension polls. Polling is unglamorous but it survives sleeping
 * laptops, dropped wifi and Fly restarts without reconnect logic, and there
 * is no new dependency (the overlay deploy path can't npm install).
 *
 * SECURITY — read before extending this.
 * This is the most dangerous surface in the app: it executes actions in a
 * signed-in human's browser, with their cookies, on their behalf. Three
 * things hold it in check and none of them are optional:
 *   1. A pairing token. Without BROWSER_CONTROL_TOKEN set, the bus refuses
 *      to arm at all — it fails closed, not open.
 *   2. The extension is off by default and the human turns it on per session.
 *      A connected extension that is switched off accepts nothing.
 *   3. Every command is recorded with its result, so what Harvey did to a
 *      browser is auditable after the fact.
 * Deliberately NOT offered: reading cookies, localStorage, password fields,
 * or executing arbitrary JavaScript. Those turn "fill in this form" into
 * "exfiltrate this session", and no use case in the spec needs them.
 */
import { randomUUID } from "crypto";

export type BrowserAction = "navigate" | "click" | "fill" | "read" | "extract" | "wait";

export interface BrowserCommand {
  id: string;
  action: BrowserAction;
  /** CSS selector, or visible text for click. */
  selector?: string;
  url?: string;
  /** For fill: selector → value. */
  fields?: Record<string, string>;
  text?: string;
  /** For extract: named selectors to pull. */
  schema?: Record<string, string>;
  timeoutMs?: number;
  createdAt: string;
  issuedBy: string;
}

export interface BrowserResult {
  id: string;
  ok: boolean;
  /** Page text, extracted fields, or a confirmation. */
  data?: unknown;
  error?: string;
  url?: string;
  title?: string;
  at: string;
}

interface Pending {
  command: BrowserCommand;
  resolve: (r: BrowserResult) => void;
  timer: NodeJS.Timeout;
}

/** Commands handed out but not yet answered. */
const pending = new Map<string, Pending>();
/** Waiting to be picked up by the extension's next poll. */
let queue: BrowserCommand[] = [];
/** Rolling audit trail. */
const history: { command: BrowserCommand; result?: BrowserResult }[] = [];
const MAX_HISTORY = 200;

let lastPollAt = 0;
let extensionEnabled = false;
let extensionPage: { url?: string; title?: string } = {};

/** Considered live if it polled recently — the extension polls every ~2s. */
const CONNECTED_WINDOW_MS = 8000;

export function isConfigured(): boolean {
  return Boolean(process.env.BROWSER_CONTROL_TOKEN?.trim());
}

export function tokenMatches(token: string | undefined): boolean {
  const expected = process.env.BROWSER_CONTROL_TOKEN?.trim();
  // Fail closed. An unset token must never mean "everyone is allowed" the way
  // DASHBOARD_TOKEN does elsewhere in this app — the blast radius here is a
  // human's live browser session.
  if (!expected) return false;
  return typeof token === "string" && token.trim() === expected;
}

export interface BrowserStatus {
  configured: boolean;
  connected: boolean;
  enabled: boolean;
  lastPollAt: string | null;
  queued: number;
  awaitingResult: number;
  page: { url?: string; title?: string };
}

export function status(): BrowserStatus {
  return {
    configured: isConfigured(),
    connected: Date.now() - lastPollAt < CONNECTED_WINDOW_MS,
    enabled: extensionEnabled,
    lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
    queued: queue.length,
    awaitingResult: pending.size,
    page: extensionPage,
  };
}

/**
 * Ask the extension to switch itself off at its next poll.
 *
 * Deliberately one-way: the server can DISARM a browser but can never arm
 * one. Arming has to stay a physical act by the human at the keyboard —
 * otherwise "turn it on" becomes something anyone holding the pairing token
 * can do to a signed-in browser. Turning it off is the safe direction, so
 * that half is allowed remotely.
 *
 * Exists because Harvey used to answer "browser control is now off" when he
 * had no way to do it — the toggle lived only in the popup. Saying it without
 * doing it is worse than refusing, since the operator then believes a control
 * is off while it is still armed.
 */
let disarmRequested = false;

export function requestDisarm(): { alreadyOff: boolean; connected: boolean } {
  const s = status();
  if (!s.connected) return { alreadyOff: !s.enabled, connected: false };
  if (!s.enabled) return { alreadyOff: true, connected: true };
  disarmRequested = true;
  // Anything already queued must not run in the window before the extension
  // polls and disarms — "off" has to mean off immediately.
  queue = [];
  return { alreadyOff: false, connected: true };
}

export function isDisarmPending(): boolean {
  return disarmRequested;
}

export interface PollResponse {
  commands: BrowserCommand[];
  /** Extension must switch itself off and report enabled:false next poll. */
  disarm: boolean;
}

/** Called on every extension poll. */
export function recordPoll(enabled: boolean, page?: { url?: string; title?: string }): PollResponse {
  lastPollAt = Date.now();
  extensionEnabled = enabled;
  if (page) extensionPage = page;

  if (disarmRequested) {
    // Clear only once the extension confirms it is off, so a poll that
    // crosses the request in flight doesn't drop the instruction.
    if (!enabled) disarmRequested = false;
    else return { commands: [], disarm: true };
  }

  // A switched-off extension still polls (so the UI can show it's there) but
  // is handed nothing to run.
  if (!enabled) return { commands: [], disarm: false };
  const batch = queue;
  queue = [];
  return { commands: batch, disarm: false };
}

export function submitResult(result: Omit<BrowserResult, "at">): boolean {
  const entry = pending.get(result.id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(result.id);
  const full: BrowserResult = { ...result, at: new Date().toISOString() };
  if (full.url || full.title) extensionPage = { url: full.url, title: full.title };
  const h = history.find((x) => x.command.id === result.id);
  if (h) h.result = full;
  entry.resolve(full);
  return true;
}

export interface RunOptions {
  issuedBy?: string;
  timeoutMs?: number;
}

/**
 * Queue a command and wait for the extension to report back.
 *
 * Resolves with `ok:false` rather than throwing on timeout or a disconnected
 * extension, so Harvey gets a usable explanation ("the extension isn't
 * connected") instead of a stack trace it will paraphrase badly.
 */
export function run(
  command: Omit<BrowserCommand, "id" | "createdAt" | "issuedBy">,
  opts: RunOptions = {},
): Promise<BrowserResult> {
  const s = status();
  if (!s.configured) {
    return Promise.resolve(fail("", "Browser control is not configured — BROWSER_CONTROL_TOKEN is not set on the server."));
  }
  if (!s.connected) {
    return Promise.resolve(fail("", "The Harvey browser extension isn't connected. Open Chrome, make sure the extension is installed and paired."));
  }
  if (!s.enabled) {
    return Promise.resolve(fail("", "The extension is connected but switched OFF. Turn on 'Let Harvey control this browser' in the extension popup."));
  }

  const full: BrowserCommand = {
    ...command,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    issuedBy: opts.issuedBy || "harvey",
  };

  history.unshift({ command: full });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  queue.push(full);

  const timeoutMs = opts.timeoutMs ?? command.timeoutMs ?? 25_000;
  return new Promise<BrowserResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(full.id);
      queue = queue.filter((c) => c.id !== full.id);
      const timedOut = fail(full.id, `The browser didn't respond within ${Math.round(timeoutMs / 1000)}s.`);
      const h = history.find((x) => x.command.id === full.id);
      if (h) h.result = timedOut;
      resolve(timedOut);
    }, timeoutMs);
    pending.set(full.id, { command: full, resolve, timer });
  });
}

function fail(id: string, error: string): BrowserResult {
  return { id, ok: false, error, at: new Date().toISOString() };
}

/** Audit trail — what Harvey did to this browser. */
export function recentActivity(limit = 20): {
  action: BrowserAction; selector?: string; url?: string; at: string;
  ok?: boolean; error?: string; issuedBy: string;
}[] {
  return history.slice(0, limit).map((h) => ({
    action: h.command.action,
    selector: h.command.selector,
    url: h.command.url,
    at: h.command.createdAt,
    ok: h.result?.ok,
    error: h.result?.error,
    issuedBy: h.command.issuedBy,
  }));
}

/** Test hook — resets bus state between runs. */
export function _resetForTests(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  queue = [];
  history.length = 0;
  lastPollAt = 0;
  extensionEnabled = false;
  extensionPage = {};
}
