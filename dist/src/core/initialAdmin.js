"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOCKDOWN_MARKER = void 0;
exports.runLockdownBootStep = runLockdownBootStep;
/**
 * One-time admin password rotation for the operator's dashboard testing.
 *
 * This temporary rotation uses the operator-requested testing credential.
 * It is stored as a salted scrypt hash and applied once, not as a login bypass.
 * A password changed later through the account UI survives restarts.
 *
 * After testing, change the admin password through the normal account UI.
 * Future rotations should use INITIAL_ADMIN_PASSWORD_HASH and a new marker.
 */
const authStore_js_1 = require("./authStore.js");
const users_js_1 = require("./users.js");
/** Bump this to force another rotation: all sessions die, the admin resets. */
exports.LOCKDOWN_MARKER = "2026-09-25-dashboard-testing";
/** The account the rotation targets, by the address it was seeded under. */
const ADMIN_EMAIL = "marco@example.com";
/** Salted scrypt hash for this explicitly requested temporary testing rotation. */
const TESTING_PASSWORD_HASH =
  "c220ad0cccdb44eaa6c6c4c812f9bff1:" +
  "01243615a2b31e21c2aa9b670b5c92ed128008542aac3012247d8c4308fd9a56b90e" +
  "0e0e09d5461a4514fad56f93535a6745b6695671c1dc0e1ce1ed6de7c0e8";

/**
 * Arm the lock: sign everyone out, and put a known credential on the admin.
 *
 * Never throws. A failure here must not take the site down — but it must never
 * look like success either, so the caller logs the reason loudly.
 */
function runLockdownBootStep() {
    if ((0, authStore_js_1.getSecurityState)("lockdown_marker") === exports.LOCKDOWN_MARKER) {
        return { ran: false, sessionsRevoked: 0, adminEmail: null, reason: "already applied" };
    }
    /* Every session, every user, every device. This is the "kick them all out"
       half, and it runs before the credential change so that a session belonging
       to whoever might already be inside cannot outlive the rotation. */
    const sessionsRevoked = (0, authStore_js_1.destroyAllSessions)();
    // This explicit testing rotation supersedes any older bootstrap credential.
    const hash = TESTING_PASSWORD_HASH;
    /* Target the seeded admin. If that address is gone, fall back to the first
       active admin rather than doing nothing: an operator locked out of their own
       CRM with no way back in is its own kind of outage. */
    const all = (0, users_js_1.getUsers)();
    const target = all.find((u) => (u.email || "").toLowerCase() === ADMIN_EMAIL) ||
        all.find((u) => u.role === "admin" && u.active !== false) ||
        null;
    if (target) {
        (0, users_js_1.updateUser)(target.id, { passwordHash: hash, mustChangePassword: false, active: true });
    }
    /* Every OTHER account keeps whatever password it had — their sessions are
       gone with the rest, but nothing here quietly grants anyone new access. */
    (0, authStore_js_1.recordAudit)({
        userId: null,
        userName: "system",
        action: "security.lockdown",
        detail: `Site lock armed (${exports.LOCKDOWN_MARKER}). ${sessionsRevoked} session(s) revoked. ` +
            `Admin credential rotated on ${target ? target.email : "NO ADMIN FOUND"}.`,
    });
    (0, authStore_js_1.setSecurityState)("lockdown_marker", exports.LOCKDOWN_MARKER);
    return { ran: true, sessionsRevoked, adminEmail: target ? target.email : null };
}
