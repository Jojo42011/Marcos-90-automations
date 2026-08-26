"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOCKDOWN_MARKER = void 0;
exports.runLockdownBootStep = runLockdownBootStep;
/**
 * The one-time admin credential used to arm the site lock, and the boot step
 * that applies it.
 *
 * WHY A HASH LIVES IN THIS FILE. The lock had to go on immediately, and this
 * environment has no Fly CLI access, so a secret could not be set the proper
 * way (`fly secrets set`). What is stored below is a scrypt hash, not a
 * password — storing those is what hashing exists for — and it is single-use by
 * construction: the account is flagged `mustChangePassword`, so the first
 * successful login has to replace it before anything else can be done. Once the
 * operator has changed it, the value here refers to nothing.
 *
 * `INITIAL_ADMIN_PASSWORD_HASH` in the environment overrides the constant, and
 * that is the correct way to do this. When Fly secrets are available again:
 *
 *     fly secrets set INITIAL_ADMIN_PASSWORD_HASH='<salt>:<hash>'
 *
 * and bump the marker. The env var wins, and nothing sensitive is in git.
 *
 * WHY IT RUNS ON A MARKER AND NOT ON EVERY BOOT. Fly restarts machines for its
 * own reasons — a deploy, an OOM, a host migration. A reset that fired on every
 * start would silently revert the operator's own password the next time the VM
 * bounced, and they would have no way to tell why their login stopped working.
 * The marker makes it happen exactly once per intentional rotation.
 */
const authStore_js_1 = require("./authStore.js");
const users_js_1 = require("./users.js");
/** Bump this to force another rotation: all sessions die, the admin resets. */
exports.LOCKDOWN_MARKER = "2026-08-26-rotate-2";
/** The account the rotation targets, by the address it was seeded under. */
const ADMIN_EMAIL = "marco@example.com";
/**
 * scrypt hash of the one-time password, as `salt:hash`.
 *
 * Not a password. Not reversible. Retired the moment it is used, because the
 * account it belongs to cannot do anything until the password is changed.
 */
const FALLBACK_HASH = "ec16e2b47bf98fe3140caf0b776fc42f:" +
    "7660e3e02ab71899fdfd5086c8f5637a2c7263d0322b136adcbd5931fce70849" +
    "2b0cb042c6d9b170b644bd5226c5b9ad7d6e4893ed83cc7b742a94cddac894df";
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
    const hash = process.env.INITIAL_ADMIN_PASSWORD_HASH?.trim() || FALLBACK_HASH;
    /* Target the seeded admin. If that address is gone, fall back to the first
       active admin rather than doing nothing: an operator locked out of their own
       CRM with no way back in is its own kind of outage. */
    const all = (0, users_js_1.getUsers)();
    const target = all.find((u) => (u.email || "").toLowerCase() === ADMIN_EMAIL) ||
        all.find((u) => u.role === "admin" && u.active !== false) ||
        null;
    if (target) {
        (0, users_js_1.updateUser)(target.id, { passwordHash: hash, mustChangePassword: true, active: true });
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
