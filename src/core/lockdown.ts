/**
 * The site lock: who is allowed to reach anything at all.
 *
 * WHY THIS IS ONE MIDDLEWARE AND NOT A PER-ROUTE CHECK. Before this existed
 * the app had two half-gates and a hole under each of them:
 *
 *   · `requireAuthPage` guarded ~25 page routes, but `express.static(publicDir)`
 *     served every one of those same pages as a plain file. `/crm` was gated;
 *     `/crm-brivity.html` returned the identical 696 KB with no check at all.
 *   · `dashboardTokenOk` guarded most `/api/*` routes, but **88 routes never
 *     called it** — including the tracker's whole contact book, task
 *     create/delete, scheduled-message send, team chat and `/api/users`, which
 *     was returning every account's scrypt password hash to anonymous callers.
 *     And `dashboardTokenOkIncoming()` returned TRUE whenever `DASHBOARD_TOKEN`
 *     was unset, which it was, so even the guarded routes were open.
 *
 * A per-route fix cannot hold that line: it is 440 routes today and the next
 * one someone adds is unguarded by default. So the rule is inverted here —
 * **everything requires a signed-in session, and the exceptions are listed by
 * name in this file.** A new route is protected the moment it is written.
 *
 * WHAT IS DELIBERATELY STILL PUBLIC, and why each one has to be:
 *
 *   · The login page and its endpoint, or nobody can ever get in.
 *   · `/health`, which Fly polls to decide whether the machine is alive.
 *   · Third-party webhooks (Twilio, Sinch, ManyChat's `/webhook`, Quo). These
 *     carry real inbound SMS and DMs. Locking them silently kills lead intake,
 *     which looks exactly like a quiet week. They are the weakest point in this
 *     design and are named in FORAI as such.
 *   · The client-facing pages — a listing, a market report, a published CMA,
 *     and the open/click pixels. These are what Marco's clients receive by
 *     email. They are unguessable UUIDs, they carry property data only, and
 *     locking them would break live outreach to real people.
 *
 * Everything else — every page, every API, every static file in public/ — is
 * behind a password.
 */
import type { NextFunction, Request, Response } from "express";

/**
 * Exact paths that never require a session.
 *
 * Exact match only. A prefix rule here would be a hole: `/login` as a prefix
 * would also open `/login-history`, and that is precisely the class of mistake
 * this file exists to stop.
 */
const PUBLIC_EXACT = new Set<string>([
  "/health",
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  "/favicon.ico",
  /* Third-party inbound. Real SMS and DM traffic. */
  "/webhook",
  "/webhook/twilio",
  "/sinch/inbound",
  "/api/quo/webhook",
  /* Google's OAuth redirect target — the browser arrives here unauthenticated
     by definition, carrying the code Google issued. */
  "/api/email/gmail-oauth/callback",
]);

/**
 * Prefixes that never require a session. Kept to the smallest possible set,
 * and every one of them is a client-facing surface or an asset the login page
 * itself needs to render.
 */
const PUBLIC_PREFIX: string[] = [
  "/l/",            // a single listing, linked from an alert email
  "/c/",            // a published CMA
  "/r/",            // open pixel, click redirect, unsubscribe, market report
  "/assets/",       // brand images, including the one on the login page
  "/login-assets/",
];

/** Files under public/ the login page needs before anyone has signed in. */
const PUBLIC_FILES = new Set<string>(["/login.html"]);

export interface LockdownDeps {
  /** True when the lock is armed. */
  enabled: () => boolean;
  /** Resolve the signed-in user for this request, or null. Must be cheap. */
  sessionUser: (req: Request) => { mustChangePassword?: boolean } | null;
  /** A configured machine credential, or null when none is set. */
  machineTokenOk: (req: Request) => boolean;
  /**
   * This server calling its own API from inside this process — Harvey reaching
   * the CRM. Loopback socket plus a token minted at boot and held only in
   * memory; see src/core/internalCall.ts. Optional so the gate can be
   * constructed without it.
   */
  internalCall?: (req: Request) => boolean;
}

/**
 * The only things an account carrying a temporary password may reach.
 *
 * `mustChangePassword` was a field nobody read: an admin-issued temp password,
 * or the one the site lock rotates in, would have worked forever. Signing in is
 * now only half of getting in.
 */
const CHANGE_PASSWORD_ALLOWED = new Set<string>([
  "/change-password",
  "/change-password.html",
  "/api/auth/change-password",
  "/api/auth/me",
  "/api/auth/logout",
]);

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  if (PUBLIC_FILES.has(pathname)) return true;
  return PUBLIC_PREFIX.some((p) => pathname.startsWith(p));
}

/**
 * Wants JSON rather than a redirect.
 *
 * An API call that gets a 302 to /login looks like a success to `fetch` and
 * then fails to parse, which sends whoever is debugging it to the wrong place
 * entirely. API callers get an honest 401.
 */
function wantsJson(req: Request): boolean {
  if (req.path.startsWith("/api/")) return true;
  const accept = String(req.headers.accept || "");
  return accept.includes("application/json") && !accept.includes("text/html");
}

export function makeLockdown(deps: LockdownDeps) {
  return function lockdown(req: Request, res: Response, next: NextFunction): void {
    if (!deps.enabled()) {
      next();
      return;
    }
    /* Path only — never the query string. A check that looked at the full URL
       could be walked past with `/api/users?x=/login`. */
    const pathname = req.path || "/";
    if (isPublicPath(pathname)) {
      next();
      return;
    }
    /* Checked before the session so it cannot be confused by whatever cookie
       happens to be lying around, and before the change-password wall: Harvey
       is not a person and has no password to set. */
    if (deps.internalCall?.(req)) {
      next();
      return;
    }
    const user = deps.sessionUser(req);
    if (user) {
      if (user.mustChangePassword && !CHANGE_PASSWORD_ALLOWED.has(pathname)) {
        if (wantsJson(req)) {
          res.status(403).json({ error: "Set a new password before continuing", mustChangePassword: true });
          return;
        }
        res.redirect(`/change-password?next=${encodeURIComponent(req.originalUrl || pathname)}`);
        return;
      }
      next();
      return;
    }
    /* A machine credential is accepted ONLY when one is actually configured.
       The old behaviour — no token set means everyone passes — is the bug this
       replaces, so an unset token now means "no machine access", not "open". */
    if (deps.machineTokenOk(req)) {
      next();
      return;
    }
    if (wantsJson(req)) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || pathname)}`);
  };
}
