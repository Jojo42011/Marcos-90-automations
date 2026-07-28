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

export type BrowserAction =
  | "navigate"
  | "click"
  | "fill"
  | "read"
  | "extract"
  | "wait"
  /** Block until an element/text appears — the fix for single-page apps, where
   *  the document finishes loading long before the content exists. */
  | "waitFor"
  /** Pull schema.org JSON-LD / OpenGraph. Listing portals ship their real data
   *  this way, and it survives redesigns that break every CSS selector. */
  | "structured"
  /** Bring Harvey's tab to the front — used to hand the keyboard back to the
   *  human at a login wall. */
  | "focus"
  /** Scroll to trigger lazy-loaded content before reading. */
  | "scroll"
  /** Capture the tab as an image — for pages that are visual, not textual. */
  | "screenshot";

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
  /** For scroll: "bottom" | "top" | pixel count. */
  to?: string | number;
  /** For screenshot: longest edge in px. */
  maxWidth?: number;
  /** For navigate: bring Harvey's window to the front. Defaults to true. */
  focus?: boolean;
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
  /** Side-signals the page noticed — e.g. `needsLogin`, `truncated`. Kept
   *  separate from `data` so the shape Harvey reads back doesn't change. */
  meta?: Record<string, unknown>;
  /** Base64 screenshot. Deliberately excluded from the audit history — a few
   *  hundred KB per capture would blow out memory within an afternoon. */
  image?: { media_type: string; data: string };
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

/** Longest the server will hold a poll open. Must stay under Chrome's 30s
 *  service-worker idle kill, or the extension dies mid-wait. */
const MAX_LONG_POLL_MS = 20000;

/** Considered live if it polled recently. With long polling a healthy
 *  extension answers at least every MAX_LONG_POLL_MS, so the window has to
 *  clear that plus round-trip — 8s was right for 2s polling and would have
 *  reported a perfectly healthy browser as disconnected. */
const CONNECTED_WINDOW_MS = MAX_LONG_POLL_MS + 10000;

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
let armRequested = false;
/** Set by the extension when the human has locked out remote arming. */
let armLockedByUser = false;

export function requestDisarm(): { alreadyOff: boolean; connected: boolean } {
  const s = status();
  if (!s.connected) return { alreadyOff: !s.enabled, connected: false };
  if (!s.enabled) return { alreadyOff: true, connected: true };
  armRequested = false;
  disarmRequested = true;
  wakeWaiters();
  // Anything already queued must not run in the window before the extension
  // polls and disarms — "off" has to mean off immediately.
  queue = [];
  return { alreadyOff: false, connected: true };
}

/**
 * Ask the extension to switch itself on.
 *
 * This is the one control that can escalate rather than reduce capability, so
 * it is bounded on purpose:
 *   - it does nothing unless a human has already paired this browser, and
 *   - the human can set a lock in the popup that refuses it outright.
 *
 * The operator asked for it after finding that "turn it back on" was the only
 * step he still had to leave the conversation to do. The honest trade is
 * stated in the popup rather than hidden: anyone holding the pairing token can
 * re-arm a paired browser unless the lock is on.
 */
export function requestArm(): { alreadyOn: boolean; connected: boolean; locked: boolean } {
  const s = status();
  if (!s.connected) return { alreadyOn: s.enabled, connected: false, locked: armLockedByUser };
  if (armLockedByUser) return { alreadyOn: s.enabled, connected: true, locked: true };
  if (s.enabled) return { alreadyOn: true, connected: true, locked: false };
  disarmRequested = false;
  armRequested = true;
  wakeWaiters();
  return { alreadyOn: false, connected: true, locked: false };
}

export function armLocked(): boolean {
  return armLockedByUser;
}

export interface PollResponse {
  commands: BrowserCommand[];
  /** Extension must switch itself off and report enabled:false next poll. */
  disarm: boolean;
  /** Extension may switch itself on (ignored if the user set the local lock). */
  arm: boolean;
}

/* ── Long poll ──────────────────────────────────────────────────────────────
   The extension used to poll on a fixed 2s timer, so every action carried up
   to 2s of dead time before it even started, and a multi-step task paid that
   on every step. The poll now parks server-side until a command exists, so
   dispatch is immediate and the request count drops at the same time. */

type Waiter = { resolve: (r: PollResponse) => void; timer: NodeJS.Timeout };
let waiters: Waiter[] = [];

function wakeWaiters(): void {
  if (!waiters.length) return;
  const batch = waiters;
  waiters = [];
  for (const w of batch) {
    clearTimeout(w.timer);
    w.resolve(drain());
  }
}

/** Close out parked polls with an empty answer without handing them work. */
function retireWaiters(): void {
  if (!waiters.length) return;
  const batch = waiters;
  waiters = [];
  for (const w of batch) {
    clearTimeout(w.timer);
    w.resolve({ commands: [], disarm: false, arm: false });
  }
}

/** Hand over whatever is pending right now. */
function drain(): PollResponse {
  if (disarmRequested) return { commands: [], disarm: true, arm: false };
  if (armRequested) return { commands: [], disarm: false, arm: true };
  if (!extensionEnabled) return { commands: [], disarm: false, arm: false };
  const batch = queue;
  queue = [];
  return { commands: batch, disarm: false, arm: false };
}

export interface PollOptions {
  /** How long the server may hold the request open. 0 = answer immediately. */
  waitMs?: number;
  /** Extension reports whether the human has locked out remote arming. */
  armLock?: boolean;
  /** Called if the client hangs up, so the waiter can be dropped. */
  onAbort?: (cancel: () => void) => void;
}

/** Called on every extension poll. */
export function recordPoll(
  enabled: boolean,
  page?: { url?: string; title?: string },
  opts: PollOptions = {},
): PollResponse | Promise<PollResponse> {
  lastPollAt = Date.now();
  extensionEnabled = enabled;
  if (page) extensionPage = page;
  if (typeof opts.armLock === "boolean") armLockedByUser = opts.armLock;

  // Clear the one-shot directives once the extension confirms the new state,
  // so a poll that crossed the request in flight doesn't drop the instruction.
  if (disarmRequested && !enabled) disarmRequested = false;
  if (armRequested && enabled) armRequested = false;

  // Retire any older parked poll before doing anything else.
  //
  // There is one browser on this bus, so a newer poll means every earlier one
  // is stale — its socket may already be dead (laptop slept, wifi dropped,
  // browser closed). Left in place, a dead waiter still wins the race in
  // wakeWaiters(), drains the queue, and resolves into a socket nobody is
  // reading: the command is silently lost and the caller is told "the browser
  // didn't respond" about a browser that is sitting right there. Closing them
  // out with an empty answer is harmless — the extension re-polls — and it
  // guarantees commands can only ever go to the live connection.
  retireWaiters();

  const immediate = drain();
  const hasWork = immediate.commands.length > 0 || immediate.disarm || immediate.arm;
  const waitMs = Math.min(Math.max(Number(opts.waitMs) || 0, 0), MAX_LONG_POLL_MS);
  if (hasWork || waitMs === 0) return immediate;

  return new Promise<PollResponse>((resolve) => {
    const w: Waiter = {
      resolve,
      // Time out with an empty answer rather than holding forever: the
      // extension re-polls, which doubles as the liveness signal `connected`
      // depends on.
      timer: setTimeout(() => {
        waiters = waiters.filter((x) => x !== w);
        resolve({ commands: [], disarm: false, arm: false });
      }, waitMs),
    };
    waiters.push(w);
    opts.onAbort?.(() => {
      clearTimeout(w.timer);
      waiters = waiters.filter((x) => x !== w);
      resolve({ commands: [], disarm: false, arm: false });
    });
  });
}

export function submitResult(result: Omit<BrowserResult, "at">): boolean {
  const entry = pending.get(result.id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(result.id);
  const full: BrowserResult = { ...result, at: new Date().toISOString() };
  if (full.url || full.title) extensionPage = { url: full.url, title: full.title };
  const h = history.find((x) => x.command.id === result.id);
  // Store everything EXCEPT the screenshot: the audit trail keeps the last 200
  // entries, and a few hundred KB of base64 each would be tens of megabytes
  // held forever for no investigative value. The fact a capture happened is
  // what matters here, not the pixels.
  if (h) h.result = full.image ? { ...full, image: undefined, data: { ...(full.data as object), screenshot: "[captured]" } } : full;
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
  // Hand it straight to a parked long poll instead of letting it sit until the
  // next timer tick — this is where the latency saving actually lands.
  wakeWaiters();

  // `command.timeoutMs` is how long the PAGE should keep waiting; this timer is
  // how long the SERVER waits for an answer. Treating them as the same number
  // guarantees the server gives up a moment before the browser replies, and the
  // caller sees "the browser didn't respond" for a command that worked. Add
  // headroom for the round trip.
  const timeoutMs = opts.timeoutMs
    ?? (command.timeoutMs ? command.timeoutMs + 8000 : undefined)
    ?? 25_000;
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
