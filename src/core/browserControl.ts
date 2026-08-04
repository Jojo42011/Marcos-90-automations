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
import { AsyncLocalStorage } from "async_hooks";
import { isConfigured as accountsConfigured, resolveAccount } from "./browserAccounts.js";

/* ── Account scope ──────────────────────────────────────────────────────────
   Which Harvey Connect account the current work belongs to. Set per request
   (the extension's chat, an operator command) and read wherever a device is
   picked, so a command raised inside one person's session can only ever reach
   that person's browsers.

   AsyncLocalStorage rather than a parameter threaded through every tool: the
   agent loop calls tools it does not know the shape of, and a parameter that
   an individual tool can forget to pass is a parameter that eventually routes
   a click to the wrong desk. Node built-in, so the overlay deploy path stays
   dependency-free. */
const accountScope = new AsyncLocalStorage<string>();

/** Run `fn` with every browser action scoped to one account. */
export function withAccount<T>(accountId: string | undefined, fn: () => T): T {
  if (!accountId) return fn();
  return accountScope.run(accountId, fn);
}

export function currentAccount(): string | undefined {
  return accountScope.getStore();
}

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
  /** Which paired browser runs this. Set at enqueue time, never guessed at
   *  poll time — that is what stopped two armed browsers racing for it. */
  targetDeviceId?: string;
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

/* ── Devices ────────────────────────────────────────────────────────────────
   There used to be exactly one queue, so with two browsers armed a command
   went to whichever polled first — effectively at random, and the operator had
   no way to tell which machine acted.

   Each paired browser is now a device with its own name, and every command is
   addressed to one of them before it is queued. When no device is named,
   PRIORITY decides: Marco's machine wins, because it is his system and his
   logins are the ones a listing portal expects. */
export interface BrowserDevice {
  id: string;
  name: string;
  /** Harvey Connect account this browser paired under. Devices are only ever
   *  visible to, and drivable from, their own account. */
  accountId: string;
  accountName: string;
  lastPollAt: number;
  enabled: boolean;
  armLock: boolean;
  page: { url?: string; title?: string };
  firstSeenAt: number;
  /** One-shot directives, per device — arming one browser must never arm the
   *  other, which is exactly what a shared flag would have done. */
  disarmRequested: boolean;
  armRequested: boolean;
}
/* Keyed by account + device: two people may both be running a legacy
   extension build (same "__legacy" id), and merging those two browsers into
   one record is precisely the cross-talk this is meant to prevent. */
const devices = new Map<string, BrowserDevice>();

const deviceKey = (accountId: string, deviceId: string) => `${accountId}::${deviceId}`;

/** Stands in for an extension build that predates device ids, so an operator
 *  who hasn't reinstalled yet keeps working instead of going dark. */
const LEGACY_DEVICE_ID = "__legacy";

function touchDevice(id: string, name: string, enabled: boolean,
                     account: { id: string; name: string },
                     page?: { url?: string; title?: string }, armLock?: boolean): BrowserDevice {
  const key = deviceKey(account.id, id);
  let d = devices.get(key);
  if (!d) {
    d = { id, name: name || id, accountId: account.id, accountName: account.name,
          lastPollAt: 0, enabled: false, armLock: false,
          page: {}, firstSeenAt: Date.now(), disarmRequested: false, armRequested: false };
    devices.set(key, d);
  }
  d.accountName = account.name;
  if (name) d.name = name;
  d.lastPollAt = Date.now();
  d.enabled = enabled;
  if (page) d.page = page;
  if (typeof armLock === "boolean") d.armLock = armLock;
  // Clear one-shot directives once this device confirms the new state.
  if (d.disarmRequested && !enabled) d.disarmRequested = false;
  if (d.armRequested && enabled) d.armRequested = false;
  return d;
}

/** Ordered, case-insensitive. First match wins; unlisted devices rank after. */
function priorityNames(): string[] {
  const raw = process.env.BROWSER_DEVICE_PRIORITY?.trim();
  return (raw || "marco").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function priorityRank(d: BrowserDevice): number {
  const name = (d.name || "").toLowerCase();
  const names = priorityNames();
  for (let i = 0; i < names.length; i++) {
    // substring, so "Marco's MacBook" still matches a priority entry of "marco"
    if (name.includes(names[i])) return i;
  }
  return names.length;
}

function isLive(d: BrowserDevice): boolean {
  return Date.now() - d.lastPollAt < CONNECTED_WINDOW_MS;
}

/** How long a silent device stays listed before it is forgotten entirely. */
const DEVICE_FORGET_MS = 10 * 60 * 1000;

/**
 * Connected devices, best candidate first.
 *
 * `accountId` scopes the list to one Harvey Connect account. Omitting it
 * returns every account's browsers and is only correct for server-side
 * surfaces that legitimately span accounts (the operator status page). Every
 * path that ACTS on a browser passes one.
 */
export function listDevices(accountId?: string): Array<BrowserDevice & { connected: boolean; priority: number }> {
  // Drop browsers nobody has heard from in ten minutes, or the list grows
  // forever with machines that were closed days ago.
  const cutoff = Date.now() - DEVICE_FORGET_MS;
  for (const [key, d] of devices) if (d.lastPollAt < cutoff) devices.delete(key);

  const scope = accountId ?? currentAccount();
  return [...devices.values()]
    .filter((d) => !scope || d.accountId === scope)
    .map((d) => {
      const connected = isLive(d);
      /* A browser that stopped polling is NOT armed, whatever its last poll
         said. Reporting a closed laptop as "armed" is the same class of lie as
         Harvey claiming he had switched the browser off — the operator would
         believe a machine is live and controllable when it is gone. */
      return { ...d, enabled: d.enabled && connected, connected, priority: priorityRank(d) };
    })
    .sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      if (a.priority !== b.priority) return a.priority - b.priority;
      /* Among devices of EQUAL priority, prefer the one heard from most
         recently. A browser that was closed stops polling, and its lastPollAt
         falls behind within seconds — without this, a dead device kept winning
         on "first seen" and commands went into the void while a live browser
         sat idle. Priority is still the primary key, so Marco vs Wesley stays
         stable and doesn't flip as they take turns re-polling. */
      if (a.lastPollAt !== b.lastPollAt) return b.lastPollAt - a.lastPollAt;
      return a.firstSeenAt - b.firstSeenAt;
    });
}

/**
 * Which device should run this command.
 *
 * `wanted` may be a device id or part of a name ("marco", "wesley"). Naming a
 * device that is present but switched OFF is an error rather than a silent
 * fall-through to someone else's browser — quietly acting on a different
 * machine than the one asked for is the worst outcome here.
 */
export function resolveDevice(wanted?: string, accountId?: string): { device: BrowserDevice | null; error: string | null } {
  const scope = accountId ?? currentAccount();
  const live = listDevices(scope).filter((d) => d.connected);
  if (!live.length) return { device: null, error: "No paired browser is connected." };

  if (wanted && wanted.trim()) {
    const w = wanted.trim().toLowerCase();
    const hit = live.find((d) => d.id.toLowerCase() === w)
      || live.find((d) => (d.name || "").toLowerCase() === w)
      || live.find((d) => (d.name || "").toLowerCase().includes(w));
    if (!hit) {
      return { device: null, error: `No connected browser matches "${wanted}". Connected: ${live.map((d) => d.name || d.id).join(", ")}.` };
    }
    if (!hit.enabled) {
      return { device: null, error: `${hit.name || hit.id} is connected but switched OFF — ask them to turn on 'Let Harvey control this browser'.` };
    }
    return { device: hit, error: null };
  }

  const armed = live.filter((d) => d.enabled);
  if (!armed.length) {
    return { device: null, error: "A browser is connected but none are switched on. Turn on 'Let Harvey control this browser' in the extension popup." };
  }
  return { device: armed[0], error: null };   // already priority-sorted
}

/** Longest the server will hold a poll open. Must stay under Chrome's 30s
 *  service-worker idle kill, or the extension dies mid-wait. */
const MAX_LONG_POLL_MS = 20000;

/** Considered live if it polled recently. With long polling a healthy
 *  extension answers at least every MAX_LONG_POLL_MS, so the window has to
 *  clear that plus round-trip — 8s was right for 2s polling and would have
 *  reported a perfectly healthy browser as disconnected. */
const CONNECTED_WINDOW_MS = MAX_LONG_POLL_MS + 10000;

export function isConfigured(): boolean {
  return accountsConfigured();
}

/**
 * Does this token belong to ANY Harvey Connect account?
 *
 * Fails closed: no configured account must never mean "everyone is allowed"
 * the way DASHBOARD_TOKEN does elsewhere — the blast radius here is a human's
 * live browser session. Callers that need to know WHOSE token it is (which is
 * most of them now) should use `accountForToken` instead.
 */
export function tokenMatches(token: string | undefined): boolean {
  return resolveAccount(token) !== null;
}

/** The account a pairing token belongs to, or null. */
export function accountForToken(token: string | undefined) {
  return resolveAccount(token);
}

export interface BrowserStatus {
  configured: boolean;
  connected: boolean;
  enabled: boolean;
  devices: Array<{
    id: string; name: string; connected: boolean; enabled: boolean;
    armLock: boolean; page: { url?: string; title?: string }; priority: number;
    account: string;
  }>;
  /** Name of the browser an unaddressed command would go to. */
  activeDevice: string | null;
  lastPollAt: string | null;
  queued: number;
  awaitingResult: number;
  page: { url?: string; title?: string };
}

export function status(accountId?: string): BrowserStatus {
  const all = listDevices(accountId);
  const live = all.filter((d) => d.connected);
  const scoped = Boolean(accountId ?? currentAccount());
  return {
    configured: isConfigured(),
    /* The global `lastPollAt` fallback covers an extension build old enough to
       send no device id at all. It must NOT apply to an account-scoped call:
       any browser polling would otherwise report as "connected" to everyone,
       so Carlos would be told a browser was live because Marco's was. */
    connected: live.length > 0 || (!scoped && Date.now() - lastPollAt < CONNECTED_WINDOW_MS),
    enabled: live.some((d) => d.enabled),
    devices: all.map((d) => ({
      id: d.id, name: d.name, connected: d.connected, enabled: d.enabled,
      armLock: d.armLock, page: d.page, priority: d.priority, account: d.accountName,
    })),
    /** Who an unaddressed command would go to right now. */
    activeDevice: live.filter((d) => d.enabled)[0]?.name || null,
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

export function requestDisarm(wanted?: string, accountId?: string): { alreadyOff: boolean; connected: boolean; device?: string } {
  const live = listDevices(accountId ?? currentAccount()).filter((d) => d.connected);
  if (!live.length) return { alreadyOff: true, connected: false };

  /* No device named = disarm EVERYTHING. "Turn the browser off" said out loud
     means stop, not stop on one of two machines — the safe direction should
     never need a second instruction to finish the job. */
  const targets = wanted
    ? live.filter((d) => d.id.toLowerCase() === wanted.toLowerCase()
        || (d.name || "").toLowerCase().includes(wanted.toLowerCase()))
    : live;
  if (!targets.length) return { alreadyOff: false, connected: true };

  const armed = targets.filter((d) => d.enabled);
  if (!armed.length) {
    return { alreadyOff: true, connected: true, device: targets.map((d) => d.name).join(", ") };
  }
  for (const t of armed) {
    const d = devices.get(deviceKey(t.accountId, t.id))!;
    d.armRequested = false;
    d.disarmRequested = true;
    // Anything queued for it must not run in the window before it disarms.
    queue = queue.filter((c) => c.targetDeviceId !== d.id);
    wakeWaiters(d.accountId, d.id);
  }
  return { alreadyOff: false, connected: true, device: armed.map((d) => d.name).join(", ") };
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
export function requestArm(wanted?: string, accountId?: string): { alreadyOn: boolean; connected: boolean; locked: boolean; device?: string } {
  const live = listDevices(accountId ?? currentAccount()).filter((d) => d.connected);
  if (!live.length) return { alreadyOn: false, connected: false, locked: false };

  /* Arming, unlike disarming, targets ONE browser — the priority pick when
     none is named. Switching on every paired machine at once because someone
     said "turn it back on" would arm a browser nobody was looking at. */
  const pick = wanted
    ? live.find((d) => d.id.toLowerCase() === wanted.toLowerCase()
        || (d.name || "").toLowerCase().includes(wanted.toLowerCase()))
    : live[0];
  if (!pick) return { alreadyOn: false, connected: true, locked: false };
  if (pick.armLock) return { alreadyOn: pick.enabled, connected: true, locked: true, device: pick.name };
  if (pick.enabled) return { alreadyOn: true, connected: true, locked: false, device: pick.name };

  const d = devices.get(deviceKey(pick.accountId, pick.id))!;
  d.disarmRequested = false;
  d.armRequested = true;
  wakeWaiters(d.accountId, d.id);
  return { alreadyOn: false, connected: true, locked: false, device: d.name };
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

type Waiter = { key: string; accountId: string; deviceId: string; resolve: (r: PollResponse) => void; timer: NodeJS.Timeout };
let waiters: Waiter[] = [];

/** Wake parked polls. With a target, only that device's poll is answered. */
function wakeWaiters(accountId?: string, deviceId?: string): void {
  if (!waiters.length) return;
  const key = accountId && deviceId ? deviceKey(accountId, deviceId) : null;
  const hit = key ? waiters.filter((w) => w.key === key) : waiters;
  if (!hit.length) return;
  waiters = waiters.filter((w) => !hit.includes(w));
  for (const w of hit) {
    clearTimeout(w.timer);
    w.resolve(drain(w.accountId, w.deviceId));
  }
}

/** Close out parked polls with an empty answer without handing them work. */
function retireWaiters(accountId: string, deviceId: string): void {
  const key = deviceKey(accountId, deviceId);
  const stale = waiters.filter((w) => w.key === key);
  if (!stale.length) return;
  waiters = waiters.filter((w) => w.key !== key);
  for (const w of stale) {
    clearTimeout(w.timer);
    w.resolve({ commands: [], disarm: false, arm: false });
  }
}

/** Hand over whatever is pending right now. */
/**
 * Hand over whatever is pending for ONE device.
 *
 * Filtering by target here is the whole fix: a command addressed to Marco's
 * machine stays in the queue when anyone else polls, instead of being taken by
 * whoever happened to ask first.
 */
function drain(accountId?: string, deviceId?: string): PollResponse {
  const dev = accountId && deviceId ? devices.get(deviceKey(accountId, deviceId)) : undefined;
  if (dev) {
    if (dev.disarmRequested) return { commands: [], disarm: true, arm: false };
    if (dev.armRequested) return { commands: [], disarm: false, arm: true };
    if (!dev.enabled) return { commands: [], disarm: false, arm: false };
    const mine = queue.filter((c) => c.targetDeviceId === deviceId);
    if (mine.length) queue = queue.filter((c) => c.targetDeviceId !== deviceId);
    return { commands: mine, disarm: false, arm: false };
  }
  // Legacy single-device path: an older extension build that sends no device id.
  if (disarmRequested) return { commands: [], disarm: true, arm: false };
  if (armRequested) return { commands: [], disarm: false, arm: true };
  if (!extensionEnabled) return { commands: [], disarm: false, arm: false };
  const batch = queue.filter((c) => !c.targetDeviceId || c.targetDeviceId === LEGACY_DEVICE_ID);
  if (batch.length) queue = queue.filter((c) => !(!c.targetDeviceId || c.targetDeviceId === LEGACY_DEVICE_ID));
  return { commands: batch, disarm: false, arm: false };
}

export interface PollOptions {
  /** Which Harvey Connect account this browser paired under. */
  account?: { id: string; name: string };
  /** Stable per-browser id, generated by the extension. */
  deviceId?: string;
  /** Human name from the popup — this is what priority matches on. */
  deviceName?: string;
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

  const deviceId = (opts.deviceId || "").trim() || LEGACY_DEVICE_ID;
  const account = opts.account || { id: "__unscoped", name: "Unknown" };
  touchDevice(deviceId, (opts.deviceName || "").trim(), enabled, account, page, opts.armLock);

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
  retireWaiters(account.id, deviceId);

  const immediate = drain(account.id, deviceId);
  const hasWork = immediate.commands.length > 0 || immediate.disarm || immediate.arm;
  const waitMs = Math.min(Math.max(Number(opts.waitMs) || 0, 0), MAX_LONG_POLL_MS);
  if (hasWork || waitMs === 0) return immediate;

  return new Promise<PollResponse>((resolve) => {
    const w: Waiter = {
      key: deviceKey(account.id, deviceId),
      accountId: account.id,
      deviceId,
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
  /** Device id or part of a name. Omitted = highest-priority armed browser,
   *  which is Marco's unless BROWSER_DEVICE_PRIORITY says otherwise. */
  device?: string;
  /** Harvey Connect account to resolve the device within. Defaults to the
   *  ambient account scope set by withAccount(). */
  account?: string;
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

  /* Pick the browser BEFORE queueing. The old code queued blind and let
     whichever extension polled first take the command, so with two machines
     armed the operator could not tell — or choose — which one acted. */
  const target = resolveDevice(opts.device, opts.account);
  if (!target.device) return Promise.resolve(fail("", target.error || "No browser available."));

  const targetAccountId = target.device.accountId;
  const full: BrowserCommand = {
    ...command,
    id: randomUUID(),
    targetDeviceId: target.device.id,
    createdAt: new Date().toISOString(),
    issuedBy: opts.issuedBy || "harvey",
  };

  history.unshift({ command: full });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  queue.push(full);
  // Hand it straight to that device's parked long poll instead of letting it
  // sit until the next timer tick — this is where the latency saving lands.
  wakeWaiters(targetAccountId, target.device.id);

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
  /* Devices and parked polls have to go too. They didn't before, so state
     leaked between runs: a device paired in one scenario stayed visible in the
     next, and a parked waiter kept a live timer pointing at a resolved test. */
  for (const w of waiters) clearTimeout(w.timer);
  waiters = [];
  devices.clear();
  queue = [];
  history.length = 0;
  lastPollAt = 0;
  extensionEnabled = false;
  extensionPage = {};
  disarmRequested = false;
  armRequested = false;
  armLockedByUser = false;
}
