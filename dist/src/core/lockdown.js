"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPublicPath = isPublicPath;
exports.makeLockdown = makeLockdown;
/**
 * Exact paths that never require a session.
 *
 * Exact match only. A prefix rule here would be a hole: `/login` as a prefix
 * would also open `/login-history`, and that is precisely the class of mistake
 * this file exists to stop.
 */
const PUBLIC_EXACT = new Set([
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
const PUBLIC_PREFIX = [
    "/l/", // a single listing, linked from an alert email
    "/c/", // a published CMA
    "/r/", // open pixel, click redirect, unsubscribe, market report
    "/assets/", // brand images, including the one on the login page
    "/login-assets/",
];
/** Files under public/ the login page needs before anyone has signed in. */
const PUBLIC_FILES = new Set(["/login.html"]);
/**
 * The only things an account carrying a temporary password may reach.
 *
 * `mustChangePassword` was a field nobody read: an admin-issued temp password,
 * or the one the site lock rotates in, would have worked forever. Signing in is
 * now only half of getting in.
 */
const CHANGE_PASSWORD_ALLOWED = new Set([
    "/change-password",
    "/change-password.html",
    "/api/auth/change-password",
    "/api/auth/me",
    "/api/auth/logout",
]);
function isPublicPath(pathname) {
    if (PUBLIC_EXACT.has(pathname))
        return true;
    if (PUBLIC_FILES.has(pathname))
        return true;
    return PUBLIC_PREFIX.some((p) => pathname.startsWith(p));
}
/**
 * Wants JSON rather than a redirect.
 *
 * An API call that gets a 302 to /login looks like a success to `fetch` and
 * then fails to parse, which sends whoever is debugging it to the wrong place
 * entirely. API callers get an honest 401.
 */
function wantsJson(req) {
    if (req.path.startsWith("/api/"))
        return true;
    const accept = String(req.headers.accept || "");
    return accept.includes("application/json") && !accept.includes("text/html");
}
function makeLockdown(deps) {
    return function lockdown(req, res, next) {
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
