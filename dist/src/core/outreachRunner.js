"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.REPORT_FREQUENCY_LABELS = exports.ALERT_FREQUENCY_LABELS = void 0;
exports.nextAlertSend = nextAlertSend;
exports.nextReportSend = nextReportSend;
exports.newMatchesFor = newMatchesFor;
exports.sendAlertNow = sendAlertNow;
exports.sendReportNow = sendReportNow;
exports.anchorFor = anchorFor;
exports.runOutreach = runOutreach;
exports.scheduleOutreach = scheduleOutreach;
exports.noteEngagement = noteEngagement;
/**
 * The send loop for Listing Alerts and Market Reports.
 *
 * WHAT COUNTS AS "NEW" is the whole problem. A naive alert re-sends every
 * matching listing on every run, which trains the client to ignore the email —
 * and a date-based "listed since last run" filter misses the two events a buyer
 * most wants: a price drop and a listing going pending. So a listing is
 * included when it is one of:
 *
 *   new            — this alert has never sent it
 *   price_change   — the list price differs from what we last told them
 *   status_change  — the status differs (Active → Pending is the notable one)
 *
 * That state is per alert, not global, because two buyers watching the same
 * postal code have separately been told separate things.
 *
 * NOTHING IS SENT WITHOUT A REAL DELIVERY. Every path here resolves only on the
 * email transport accepting the message; a failure is recorded as a failed send
 * with the transport's own words, and `sent_listings` is NOT updated — so the
 * next run retries those listings rather than skipping them as already seen.
 */
const index_js_1 = require("../integrations/gmail/index.js");
const db_js_1 = require("./db.js");
const listingCriteria_js_1 = require("./listingCriteria.js");
const marketReport_js_1 = require("./marketReport.js");
const outreachEmail_js_1 = require("./outreachEmail.js");
const outreachStore_js_1 = require("./outreachStore.js");
exports.ALERT_FREQUENCY_LABELS = {
    daily: "daily", weekly: "weekly", monthly: "monthly",
};
exports.REPORT_FREQUENCY_LABELS = {
    monthly: "monthly", quarterly: "quarterly", semiannual: "twice-yearly", annual: "yearly",
};
const DAY_MS = 24 * 60 * 60 * 1000;
/** The CC field is one typed address; the transport takes a list. */
function ccList(cc) {
    const parts = String(cc || "").split(/[,;]/).map((s) => s.trim()).filter((s) => /.+@.+\..+/.test(s));
    return parts.length ? parts : undefined;
}
function nextAlertSend(frequency, from = new Date()) {
    const days = frequency === "daily" ? 1 : frequency === "weekly" ? 7 : 30;
    return new Date(from.getTime() + days * DAY_MS).toISOString();
}
function nextReportSend(frequency, from = new Date()) {
    const months = frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : frequency === "semiannual" ? 6 : 12;
    const d = new Date(from.getTime());
    d.setMonth(d.getMonth() + months);
    return d.toISOString();
}
/** How many listings to put in one email — beyond this it stops being read. */
const MAX_PER_EMAIL = 12;
/**
 * Listings this alert should tell the contact about right now.
 *
 * Reads a wider slice than it sends: the newest 200 matches are examined so a
 * price change on a listing further down the list is still caught, then the
 * result is capped for the email.
 */
function newMatchesFor(alert, limit = MAX_PER_EMAIL) {
    const seen = (0, outreachStore_js_1.sentListingsFor)(alert.id);
    const candidates = (0, listingCriteria_js_1.findMatching)(alert.criteria, 200);
    const out = [];
    for (const l of candidates) {
        const prev = seen.get(l.listingKey);
        if (!prev) {
            out.push({ listing: l, reason: "new" });
            continue;
        }
        const priceMoved = prev.lastPrice != null && l.listPrice != null && Number(prev.lastPrice) !== Number(l.listPrice);
        if (priceMoved) {
            out.push({ listing: l, reason: "price_change" });
            continue;
        }
        const statusMoved = (prev.lastStatus || "") !== (l.status || "");
        if (statusMoved)
            out.push({ listing: l, reason: "status_change" });
    }
    /* Brand-new listings first — that is what the client opened the email for. */
    const rank = { new: 0, price_change: 1, status_change: 2 };
    out.sort((a, b) => rank[a.reason] - rank[b.reason]);
    return out.slice(0, limit);
}
function unsubUrl(kind, id) {
    return `${(0, outreachEmail_js_1.publicBaseUrl)()}/r/stop?k=${kind}&id=${encodeURIComponent(id)}`;
}
/**
 * Send one alert. `force` sends whatever currently matches even if nothing has
 * changed — used by the "send an initial email immediately on save" behaviour
 * the Brivity form promises, and by an operator test.
 */
async function sendAlertNow(alertId, opts = {}) {
    const alert = (0, outreachStore_js_1.getAlert)(alertId);
    if (!alert)
        return { ok: false, error: "That listing alert no longer exists" };
    const lead = await (0, db_js_1.getLeadById)(alert.leadId);
    const to = lead?.email?.trim();
    if (!to)
        return { ok: false, skipped: "no_email", error: "This contact has no email address on file" };
    let matches = newMatchesFor(alert);
    if (!matches.length) {
        if (!opts.force) {
            /* Nothing new is a normal, quiet outcome — reschedule and say nothing.
               An email that says "no new homes" every morning gets a client to
               unsubscribe from the one that matters. */
            (0, outreachStore_js_1.updateAlert)(alert.id, { nextSendAt: nextAlertSend(alert.frequency), lastMatchCount: (0, listingCriteria_js_1.countMatching)(alert.criteria) });
            return { ok: true, skipped: "no_new_matches", listingCount: 0 };
        }
        matches = (0, listingCriteria_js_1.findMatching)(alert.criteria, MAX_PER_EMAIL).map((listing) => ({ listing, reason: "new" }));
    }
    if (!matches.length) {
        (0, outreachStore_js_1.updateAlert)(alert.id, { nextSendAt: nextAlertSend(alert.frequency), lastMatchCount: 0 });
        return { ok: true, skipped: "no_matches", listingCount: 0 };
    }
    const sendId = (0, outreachStore_js_1.newId)("snd");
    const { subject, html } = (0, outreachEmail_js_1.renderAlertEmail)({
        sendId,
        alertName: alert.name,
        contactName: lead?.name ?? null,
        criteriaLine: (0, listingCriteria_js_1.describeCriteria)(alert.criteria),
        items: matches,
        frequencyLabel: exports.ALERT_FREQUENCY_LABELS[alert.frequency],
        unsubscribeUrl: unsubUrl("alert", alert.id),
    });
    try {
        await (0, index_js_1.sendEmail)({ to, subject, body: html, html: true, cc: ccList(alert.cc) });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        (0, outreachStore_js_1.recordSend)({ id: sendId, kind: "alert", subscriptionId: alert.id, leadId: alert.leadId,
            sentAt: new Date().toISOString(), listingCount: matches.length, ok: false, error: message });
        /* Deliberately NOT marking these listings as sent — a failed delivery must
           not silence tomorrow's retry. */
        return { ok: false, error: message, sendId };
    }
    const at = new Date().toISOString();
    (0, outreachStore_js_1.recordSend)({ id: sendId, kind: "alert", subscriptionId: alert.id, leadId: alert.leadId,
        sentAt: at, listingCount: matches.length, ok: true, error: null });
    (0, outreachStore_js_1.recordSentListings)(alert.id, matches.map((m) => ({
        listingKey: m.listing.listingKey, price: m.listing.listPrice, status: m.listing.status,
    })), at);
    (0, outreachStore_js_1.updateAlert)(alert.id, {
        lastSentAt: at,
        nextSendAt: nextAlertSend(alert.frequency),
        lastMatchCount: (0, listingCriteria_js_1.countMatching)(alert.criteria),
    });
    await appendTimeline(alert.leadId, `Listing alert “${alert.name}” sent — ${matches.length} home${matches.length === 1 ? "" : "s"}`);
    return { ok: true, listingCount: matches.length, sendId };
}
async function sendReportNow(reportId) {
    const report = (0, outreachStore_js_1.getReport)(reportId);
    if (!report)
        return { ok: false, error: "That market report no longer exists" };
    const lead = await (0, db_js_1.getLeadById)(report.leadId);
    const to = lead?.email?.trim();
    if (!to)
        return { ok: false, skipped: "no_email", error: "This contact has no email address on file" };
    const built = (0, marketReport_js_1.buildMarketReport)({
        criteria: report.criteria,
        anchor: anchorFor(report),
        subject: report.subject,
        adjustedValue: report.adjustedValue,
    });
    const sendId = (0, outreachStore_js_1.newId)("snd");
    /* The custom note is a first-send thing by Brivity's own definition, and by
       common sense: "I put this together for you" reads badly on the fourth one. */
    const isFirst = (0, outreachStore_js_1.listSends)(report.id, 1).length === 0;
    const { subject, html } = (0, outreachEmail_js_1.renderReportEmail)({
        sendId,
        reportName: report.name,
        contactName: lead?.name ?? null,
        address: report.address,
        report: built,
        includeHomeValue: report.includeHomeValue,
        customMessage: isFirst ? report.emailMessage : null,
        frequencyLabel: exports.REPORT_FREQUENCY_LABELS[report.frequency],
        unsubscribeUrl: unsubUrl("report", report.id),
        viewUrl: `${(0, outreachEmail_js_1.publicBaseUrl)()}/r/report?id=${encodeURIComponent(report.id)}&s=${encodeURIComponent(sendId)}`,
    });
    try {
        await (0, index_js_1.sendEmail)({ to, subject, body: html, html: true, cc: ccList(report.cc) });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        (0, outreachStore_js_1.recordSend)({ id: sendId, kind: "report", subscriptionId: report.id, leadId: report.leadId,
            sentAt: new Date().toISOString(), listingCount: built.stats.count, ok: false, error: message });
        return { ok: false, error: message, sendId };
    }
    const at = new Date().toISOString();
    (0, outreachStore_js_1.recordSend)({ id: sendId, kind: "report", subscriptionId: report.id, leadId: report.leadId,
        sentAt: at, listingCount: built.stats.count, ok: true, error: null });
    (0, outreachStore_js_1.updateReport)(report.id, {
        lastSentAt: at,
        nextSendAt: report.drip ? nextReportSend(report.frequency) : null,
    });
    await appendTimeline(report.leadId, `Market report “${report.name}” sent — ${built.area.label}`);
    return { ok: true, listingCount: built.stats.count, sendId };
}
/** Best-effort note on the contact's timeline; never fails the send. */
async function appendTimeline(leadId, description) {
    try {
        const { appendLeadActivity } = await Promise.resolve().then(() => __importStar(require("./db.js")));
        await appendLeadActivity(leadId, [{ type: "email_sent", description, timestamp: new Date().toISOString() }]);
    }
    catch { /* the email went out; the timeline note is a convenience */ }
}
function anchorFor(report) {
    const fromCriteria = report.criteria.postalCodes?.[0] || null;
    return {
        postalCode: fromCriteria || (0, marketReport_js_1.postalFromAddress)(report.address),
        city: report.criteria.cities?.[0] || (0, marketReport_js_1.cityFromAddress)(report.address),
    };
}
/** One pass over everything due. Safe to call repeatedly. */
async function runOutreach() {
    const out = {
        alertsDue: 0, alertsSent: 0, alertsQuiet: 0, alertsFailed: 0,
        reportsDue: 0, reportsSent: 0, reportsFailed: 0, errors: [], ranAt: new Date().toISOString(),
    };
    const alerts = (0, outreachStore_js_1.dueAlerts)();
    out.alertsDue = alerts.length;
    for (const a of alerts) {
        try {
            const r = await sendAlertNow(a.id);
            if (!r.ok) {
                out.alertsFailed++;
                out.errors.push(`${a.name}: ${r.error}`);
            }
            else if (r.skipped)
                out.alertsQuiet++;
            else
                out.alertsSent++;
        }
        catch (err) {
            out.alertsFailed++;
            out.errors.push(`${a.name}: ${err.message}`);
        }
    }
    const reports = (0, outreachStore_js_1.dueReports)();
    out.reportsDue = reports.length;
    for (const m of reports) {
        try {
            const r = await sendReportNow(m.id);
            if (!r.ok) {
                out.reportsFailed++;
                out.errors.push(`${m.name}: ${r.error}`);
            }
            else
                out.reportsSent++;
        }
        catch (err) {
            out.reportsFailed++;
            out.errors.push(`${m.name}: ${err.message}`);
        }
    }
    return out;
}
/**
 * Hourly tick. Frequencies are day-scale, so the hour is fine granularity and
 * keeps a restart from bunching every alert onto the same minute.
 */
function scheduleOutreach(intervalMinutes = 60) {
    const run = () => {
        runOutreach()
            .then((r) => {
            if (r.alertsSent || r.reportsSent) {
                console.log(`[Outreach] sent ${r.alertsSent} listing alert(s), ${r.reportsSent} market report(s)`);
            }
            if (r.errors.length)
                console.error("[Outreach] problems:", r.errors.slice(0, 5).join(" | "));
        })
            .catch((e) => console.error("[Outreach] run threw:", e));
    };
    setTimeout(run, 90_000); // let boot and the MLS sync settle first
    setInterval(run, Math.max(5, intervalMinutes) * 60 * 1000);
    console.log(`[Outreach] listing alerts + market reports scheduled every ${intervalMinutes}m`);
}
/** Record a click and mirror it onto the contact's timeline. */
async function noteEngagement(input) {
    (0, outreachStore_js_1.recordEngagement)(input);
    /* Opens are noisy — a mail client can prefetch a pixel — so only the
       deliberate actions reach the timeline, where they are read as intent. */
    if (input.event !== "email_opened")
        await appendTimeline(input.leadId, input.description);
}
