/**
 * Team sign-in session — shared by shell.html, who.html and team-tasks.html.
 *
 * Two separate pieces of state, on purpose:
 *
 *   localStorage "marcoTaskUser"  — WHO you are. Every page in the app reads
 *     this key directly (Task Command has since day one), so it stays put and
 *     survives the browser closing. Nothing here changes that contract.
 *
 *   cookie "mp_team_session"      — whether THIS BROWSER SESSION has signed
 *     in. Written with no max-age, so the browser drops it on close. This is
 *     what makes the sign-in screen appear when you come back to the site,
 *     instead of silently reusing a name picked days ago.
 *
 * The first version only checked localStorage, which meant you picked a name
 * once and were never asked again on that device — indistinguishable from the
 * login screen being broken, and wrong for a shared machine where the next
 * person to sit down would silently be logged in as whoever used it last.
 *
 * A third cookie, "mp_team" (long-lived), just remembers your last pick so
 * the sign-in screen can mark it "Current" — it never grants access.
 *
 * This identifies you; it is NOT a security boundary. Real password auth is
 * the separate /login screen behind SITE_LOGIN_ENABLED.
 */
(function (global) {
  "use strict";

  var USER_KEY = "marcoTaskUser";
  var SESSION_COOKIE = "mp_team_session";
  var REMEMBER_COOKIE = "mp_team";

  function readCookie(name) {
    try {
      var parts = String(document.cookie || "").split("; ");
      for (var i = 0; i < parts.length; i++) {
        var eq = parts[i].indexOf("=");
        if (eq > 0 && parts[i].slice(0, eq) === name) {
          return decodeURIComponent(parts[i].slice(eq + 1));
        }
      }
    } catch (_) {}
    return "";
  }

  /** Who this device says you are. May be set but not signed in this session. */
  function currentUser() {
    try { return localStorage.getItem(USER_KEY) || ""; } catch (_) { return ""; }
  }

  /**
   * Signed in *right now*. Requires both an identity and a live session
   * cookie that agrees with it — so a stale name from a previous visit does
   * not count, and neither does a session cookie left over from someone else.
   */
  function isSignedIn() {
    var me = currentUser();
    return !!me && readCookie(SESSION_COOKIE) === me;
  }

  /** Last name picked on this device, for pre-highlighting the picker. */
  function rememberedUser() {
    return readCookie(REMEMBER_COOKIE) || currentUser();
  }

  /** Returns false if the browser blocks storage (private mode), so the
   *  caller can say so rather than bouncing through a login that can't stick. */
  function signIn(id) {
    var prev = currentUser();
    try { localStorage.setItem(USER_KEY, id); } catch (_) { return false; }

    var enc = encodeURIComponent(id);
    // No max-age → dies with the browser session. This is the login itself.
    document.cookie = SESSION_COOKIE + "=" + enc + "; path=/; samesite=lax";
    // Long-lived, display only.
    document.cookie = REMEMBER_COOKIE + "=" + enc + "; path=/; max-age=31536000; samesite=lax";

    // Someone else now: drop this device's popup-dedup sets so the new
    // person's notifications register as new rather than already-seen.
    if (prev && prev !== id) {
      try {
        localStorage.removeItem("shell_note_seen");
        localStorage.removeItem("tt_seen");
      } catch (_) {}
    }
    return true;
  }

  function signOut() {
    try { localStorage.removeItem(USER_KEY); } catch (_) {}
    document.cookie = SESSION_COOKIE + "=; path=/; max-age=0; samesite=lax";
  }

  function signInUrl(next) {
    var target = next || (location.pathname + location.search);
    return "/who?next=" + encodeURIComponent(target);
  }

  /**
   * Bounce to the sign-in screen unless this session is signed in.
   * Call synchronously, before render, so the app never flashes into view
   * for someone we haven't identified. replace() keeps Back from looping.
   */
  function requireSignIn() {
    if (isSignedIn()) return true;
    location.replace(signInUrl());
    return false;
  }

  global.TeamSession = {
    USER_KEY: USER_KEY,
    currentUser: currentUser,
    rememberedUser: rememberedUser,
    isSignedIn: isSignedIn,
    signIn: signIn,
    signOut: signOut,
    signInUrl: signInUrl,
    requireSignIn: requireSignIn,
  };
})(window);
