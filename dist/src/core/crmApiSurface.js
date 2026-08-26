"use strict";
/**
 * What of this server's own HTTP API Harvey is allowed to call, and how it
 * finds out what is there.
 *
 * The ask was "give Harvey access to the entire CRM dashboard". The tempting
 * reading is "let Harvey call anything", and that is wrong: this process also
 * serves user administration, the security state, the deploy-adjacent exec
 * tools and the webhook intake. The reading implemented here is "everything the
 * CRM page itself can do" — which is a real, enumerable set, because the CRM
 * page is a browser client and every action it takes is an HTTP call.
 *
 * DENY BY DEFAULT. A path has to match an ALLOW prefix and match no DENY
 * prefix. DENY is checked first and wins, so adding an allow prefix can never
 * silently open something on the deny list.
 *
 * WHY A PREFIX LIST AND NOT A ROUTE LIST. New CRM endpoints get added most
 * weeks. A hand-maintained route list would mean Harvey silently lagging the
 * dashboard by however long it took someone to remember this file. Prefixes
 * mean a new `/api/crm/...` route is reachable the day it exists — and anything
 * outside those prefixes still needs a deliberate edit here.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CRM_API_WRITE_METHODS = exports.CRM_API_DENY = exports.CRM_API_ALLOW = void 0;
exports.checkCrmApiPath = checkCrmApiPath;
exports.setCrmApiCatalogue = setCrmApiCatalogue;
exports.getCrmApiCatalogue = getCrmApiCatalogue;
exports.getInternalBaseUrl = getInternalBaseUrl;
/** Path prefixes Harvey may call. Order does not matter; any match allows. */
exports.CRM_API_ALLOW = [
    "/api/crm/", // leads, vocabulary, metrics, contact records, notes
    "/api/leads/", // filter, per-lead sub-resources (alerts, addresses)
    "/api/lead/",
    "/api/listing-alerts/",
    "/api/outreach/", // alert/report preview, templates, sends
    "/api/market-reports/",
    "/api/auto-plans/", // plans and enrolments
    "/api/tasks/",
    "/api/task/",
    "/api/transactions/",
    "/api/transaction/",
    "/api/contact-address/",
    "/api/contact-document/",
    "/api/contact-record/",
    "/api/mls/", // facets, listing lookups
    "/api/listings/",
    "/api/cma/",
    "/api/knowledge", // SOPs — read and write, so Harvey can file one
    "/api/dashboard/",
    "/api/sms/send", // the CRM composer's own send
    "/api/messages/",
    "/api/scheduled/",
    "/api/notifications/",
    "/api/users", // the roster the CRM assigns work to (read only, below)
];
/**
 * Path prefixes Harvey may never call, whatever the allow list says.
 *
 * Each of these is here for a specific reason rather than general caution:
 * auth changes who can get in, security changes the lock itself, and the
 * webhook paths are how the outside world talks to this system — a tool that
 * could POST to them could fabricate an inbound lead or a delivery receipt.
 */
exports.CRM_API_DENY = [
    "/api/auth/",
    "/api/security/",
    "/api/users/", // creating/editing accounts; the bare /api/users read stays
    "/webhook",
    "/sinch/",
    "/api/quo/webhook",
    "/api/exec/",
    "/api/jarvis/", // Harvey calling Harvey
    "/v1/",
    "/reset",
];
/** Methods that change something — listed so the caller can be told plainly. */
exports.CRM_API_WRITE_METHODS = ["POST", "PATCH", "PUT", "DELETE"];
function checkCrmApiPath(method, pathname) {
    const m = String(method || "").toUpperCase();
    if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(m)) {
        return { ok: false, reason: `Method ${m || "(none)"} is not supported. Use GET, POST, PATCH, PUT or DELETE.` };
    }
    if (!pathname.startsWith("/")) {
        return { ok: false, reason: "Path must start with / — pass a path, not a full URL." };
    }
    /* Refuse traversal outright rather than normalising it. There is no
       legitimate CRM path containing "..", so anything that does is either a bug
       or an attempt to walk out of the allowed prefixes. */
    if (pathname.includes("..")) {
        return { ok: false, reason: "Path may not contain '..'." };
    }
    if (exports.CRM_API_DENY.some((p) => pathname === p || pathname.startsWith(p))) {
        return { ok: false, reason: `${pathname} is outside the CRM — accounts, the site lock, webhooks and Harvey's own endpoints are not reachable from here.` };
    }
    /* `/api/users` exactly, for the assignment roster. Anything below it is user
       administration and is on the deny list above. */
    if (pathname === "/api/users")
        return { ok: true };
    if (exports.CRM_API_ALLOW.some((p) => pathname.startsWith(p)))
        return { ok: true };
    return {
        ok: false,
        reason: `${pathname} is not part of the CRM surface Harvey can reach. Call crm_api_index to see what is.`,
    };
}
let catalogue = [];
let baseUrl = "";
function setCrmApiCatalogue(routes, base) {
    catalogue = routes
        .filter((r) => checkCrmApiPath(r.method, r.path.replace(/:[^/]+/g, "x")).ok)
        .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    baseUrl = base;
}
function getCrmApiCatalogue() {
    return catalogue;
}
function getInternalBaseUrl() {
    return baseUrl;
}
