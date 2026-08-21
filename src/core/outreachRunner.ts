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
import { sendEmail } from "../integrations/gmail/index.js";
import { getLeadById } from "./db.js";
import { describeCriteria, findMatching, countMatching } from "./listingCriteria.js";
import { buildMarketReport, postalFromAddress, cityFromAddress } from "./marketReport.js";
import { renderAlertEmail, renderReportEmail, publicBaseUrl } from "./outreachEmail.js";
import {
  dueAlerts, dueReports, getAlert, getReport, listSends, newId, recordEngagement,
  recordSend, recordSentListings, sentListingsFor, updateAlert, updateReport,
  type AlertFrequency, type ListingAlert, type MarketReport, type ReportFrequency,
} from "./outreachStore.js";
import type { Listing } from "./listingsStore.js";

export const ALERT_FREQUENCY_LABELS: Record<AlertFrequency, string> = {
  daily: "daily", twice_daily: "twice daily", multiple_per_day: "several times a day",
  weekly: "weekly", every_2_weeks: "every two weeks", monthly: "monthly",
};
export const REPORT_FREQUENCY_LABELS: Record<ReportFrequency, string> = {
  never: "not on a schedule", weekly: "weekly", every_2_weeks: "every two weeks",
  monthly: "monthly", quarterly: "quarterly", semiannual: "twice-yearly", annual: "yearly",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The CC field is one typed address; the transport takes a list. */
function ccList(cc: string | null): string[] | undefined {
  const parts = String(cc || "").split(/[,;]/).map((s) => s.trim()).filter((s) => /.+@.+\..+/.test(s));
  return parts.length ? parts : undefined;
}

/* The sweep runs hourly, so anything shorter than an hour cannot be honoured
   and is not offered. "Several times a day" is four-hourly — the fastest
   cadence this scheduler can actually keep. */
const ALERT_INTERVAL_MS: Record<AlertFrequency, number> = {
  daily: DAY_MS,
  twice_daily: DAY_MS / 2,
  multiple_per_day: DAY_MS / 6,
  weekly: 7 * DAY_MS,
  every_2_weeks: 14 * DAY_MS,
  monthly: 30 * DAY_MS,
};

export function nextAlertSend(frequency: AlertFrequency, from = new Date()): string {
  const step = ALERT_INTERVAL_MS[frequency] ?? DAY_MS;
  return new Date(from.getTime() + step).toISOString();
}

export function nextReportSend(frequency: ReportFrequency, from = new Date()): string {
  /* "never" means the drip is off. Returning a date far out rather than null
     keeps the column's type simple; `drip` is what the runner actually gates
     on, and this only decides where an un-dripped report sorts. */
  if (frequency === "never") return new Date(from.getTime() + 3650 * DAY_MS).toISOString();
  if (frequency === "weekly") return new Date(from.getTime() + 7 * DAY_MS).toISOString();
  if (frequency === "every_2_weeks") return new Date(from.getTime() + 14 * DAY_MS).toISOString();
  const months = frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : frequency === "semiannual" ? 6 : 12;
  const d = new Date(from.getTime());
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

/** How many listings to put in one email — beyond this it stops being read. */
const MAX_PER_EMAIL = 12;

export type MatchReason = "new" | "price_change" | "status_change";

export interface AlertMatch { listing: Listing; reason: MatchReason }

/**
 * Listings this alert should tell the contact about right now.
 *
 * Reads a wider slice than it sends: the newest 200 matches are examined so a
 * price change on a listing further down the list is still caught, then the
 * result is capped for the email.
 */
export function newMatchesFor(alert: ListingAlert, limit = MAX_PER_EMAIL): AlertMatch[] {
  const seen = sentListingsFor(alert.id);
  const candidates = findMatching(alert.criteria, 200);
  const out: AlertMatch[] = [];
  for (const l of candidates) {
    const prev = seen.get(l.listingKey);
    if (!prev) { out.push({ listing: l, reason: "new" }); continue; }
    const priceMoved = prev.lastPrice != null && l.listPrice != null && Number(prev.lastPrice) !== Number(l.listPrice);
    if (priceMoved) { out.push({ listing: l, reason: "price_change" }); continue; }
    const statusMoved = (prev.lastStatus || "") !== (l.status || "");
    if (statusMoved) out.push({ listing: l, reason: "status_change" });
  }
  /* Brand-new listings first — that is what the client opened the email for. */
  const rank: Record<MatchReason, number> = { new: 0, price_change: 1, status_change: 2 };
  out.sort((a, b) => rank[a.reason] - rank[b.reason]);
  return out.slice(0, limit);
}

export interface SendOutcome {
  ok: boolean;
  skipped?: string;
  listingCount?: number;
  sendId?: string;
  error?: string;
}

function unsubUrl(kind: "alert" | "report", id: string): string {
  return `${publicBaseUrl()}/r/stop?k=${kind}&id=${encodeURIComponent(id)}`;
}

/**
 * Send one alert. `force` sends whatever currently matches even if nothing has
 * changed — used by the "send an initial email immediately on save" behaviour
 * the Brivity form promises, and by an operator test.
 */
export async function sendAlertNow(alertId: string, opts: { force?: boolean } = {}): Promise<SendOutcome> {
  const alert = getAlert(alertId);
  if (!alert) return { ok: false, error: "That listing alert no longer exists" };
  const lead = await getLeadById(alert.leadId);
  const to = lead?.email?.trim();
  if (!to) return { ok: false, skipped: "no_email", error: "This contact has no email address on file" };

  let matches = newMatchesFor(alert);
  if (!matches.length) {
    if (!opts.force) {
      /* Nothing new is a normal, quiet outcome — reschedule and say nothing.
         An email that says "no new homes" every morning gets a client to
         unsubscribe from the one that matters. */
      updateAlert(alert.id, { nextSendAt: nextAlertSend(alert.frequency), lastMatchCount: countMatching(alert.criteria) });
      return { ok: true, skipped: "no_new_matches", listingCount: 0 };
    }
    matches = findMatching(alert.criteria, MAX_PER_EMAIL).map((listing) => ({ listing, reason: "new" as MatchReason }));
  }
  if (!matches.length) {
    updateAlert(alert.id, { nextSendAt: nextAlertSend(alert.frequency), lastMatchCount: 0 });
    return { ok: true, skipped: "no_matches", listingCount: 0 };
  }

  const sendId = newId("snd");
  const { subject, html } = renderAlertEmail({
    sendId,
    alertName: alert.name,
    contactName: lead?.name ?? null,
    criteriaLine: describeCriteria(alert.criteria),
    items: matches,
    frequencyLabel: ALERT_FREQUENCY_LABELS[alert.frequency],
    unsubscribeUrl: unsubUrl("alert", alert.id),
  });

  try {
    await sendEmail({ to, subject, body: html, html: true, cc: ccList(alert.cc) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSend({ id: sendId, kind: "alert", subscriptionId: alert.id, leadId: alert.leadId,
      sentAt: new Date().toISOString(), listingCount: matches.length, ok: false, error: message });
    /* Deliberately NOT marking these listings as sent — a failed delivery must
       not silence tomorrow's retry. */
    return { ok: false, error: message, sendId };
  }

  const at = new Date().toISOString();
  recordSend({ id: sendId, kind: "alert", subscriptionId: alert.id, leadId: alert.leadId,
    sentAt: at, listingCount: matches.length, ok: true, error: null });
  recordSentListings(alert.id, matches.map((m) => ({
    listingKey: m.listing.listingKey, price: m.listing.listPrice, status: m.listing.status,
  })), at);
  updateAlert(alert.id, {
    lastSentAt: at,
    nextSendAt: nextAlertSend(alert.frequency),
    lastMatchCount: countMatching(alert.criteria),
  });
  await appendTimeline(alert.leadId, `Listing alert “${alert.name}” sent — ${matches.length} home${matches.length === 1 ? "" : "s"}`);
  return { ok: true, listingCount: matches.length, sendId };
}

export async function sendReportNow(reportId: string): Promise<SendOutcome> {
  const report = getReport(reportId);
  if (!report) return { ok: false, error: "That market report no longer exists" };
  const lead = await getLeadById(report.leadId);
  const to = lead?.email?.trim();
  if (!to) return { ok: false, skipped: "no_email", error: "This contact has no email address on file" };

  const built = buildMarketReport({
    criteria: report.criteria,
    anchor: anchorFor(report),
    subject: report.subject,
    adjustedValue: report.adjustedValue,
  });

  const sendId = newId("snd");
  /* The custom note is a first-send thing by Brivity's own definition, and by
     common sense: "I put this together for you" reads badly on the fourth one. */
  const isFirst = listSends(report.id, 1).length === 0;
  const { subject, html } = renderReportEmail({
    sendId,
    reportName: report.name,
    contactName: lead?.name ?? null,
    address: report.address,
    report: built,
    includeHomeValue: report.includeHomeValue,
    customMessage: isFirst ? report.emailMessage : null,
    frequencyLabel: REPORT_FREQUENCY_LABELS[report.frequency],
    unsubscribeUrl: unsubUrl("report", report.id),
    viewUrl: `${publicBaseUrl()}/r/report?id=${encodeURIComponent(report.id)}&s=${encodeURIComponent(sendId)}`,
  });

  try {
    await sendEmail({ to, subject, body: html, html: true, cc: ccList(report.cc) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSend({ id: sendId, kind: "report", subscriptionId: report.id, leadId: report.leadId,
      sentAt: new Date().toISOString(), listingCount: built.stats.count, ok: false, error: message });
    return { ok: false, error: message, sendId };
  }

  const at = new Date().toISOString();
  recordSend({ id: sendId, kind: "report", subscriptionId: report.id, leadId: report.leadId,
    sentAt: at, listingCount: built.stats.count, ok: true, error: null });
  updateReport(report.id, {
    lastSentAt: at,
    nextSendAt: report.drip ? nextReportSend(report.frequency) : null,
  });
  await appendTimeline(report.leadId, `Market report “${report.name}” sent — ${built.area.label}`);
  return { ok: true, listingCount: built.stats.count, sendId };
}

/** Best-effort note on the contact's timeline; never fails the send. */
async function appendTimeline(leadId: string, description: string): Promise<void> {
  try {
    const { appendLeadActivity } = await import("./db.js");
    await appendLeadActivity(leadId, [{ type: "email_sent", description, timestamp: new Date().toISOString() }]);
  } catch { /* the email went out; the timeline note is a convenience */ }
}

export function anchorFor(report: MarketReport): { postalCode?: string | null; city?: string | null } {
  const fromCriteria = report.criteria.postalCodes?.[0] || null;
  return {
    postalCode: fromCriteria || postalFromAddress(report.address),
    city: report.criteria.cities?.[0] || cityFromAddress(report.address),
  };
}

export interface RunResult {
  alertsDue: number;
  alertsSent: number;
  alertsQuiet: number;
  alertsFailed: number;
  reportsDue: number;
  reportsSent: number;
  reportsFailed: number;
  errors: string[];
  ranAt: string;
}

/** One pass over everything due. Safe to call repeatedly. */
export async function runOutreach(): Promise<RunResult> {
  const out: RunResult = {
    alertsDue: 0, alertsSent: 0, alertsQuiet: 0, alertsFailed: 0,
    reportsDue: 0, reportsSent: 0, reportsFailed: 0, errors: [], ranAt: new Date().toISOString(),
  };
  const alerts = dueAlerts();
  out.alertsDue = alerts.length;
  for (const a of alerts) {
    try {
      const r = await sendAlertNow(a.id);
      if (!r.ok) { out.alertsFailed++; out.errors.push(`${a.name}: ${r.error}`); }
      else if (r.skipped) out.alertsQuiet++;
      else out.alertsSent++;
    } catch (err) {
      out.alertsFailed++;
      out.errors.push(`${a.name}: ${(err as Error).message}`);
    }
  }
  const reports = dueReports();
  out.reportsDue = reports.length;
  for (const m of reports) {
    try {
      const r = await sendReportNow(m.id);
      if (!r.ok) { out.reportsFailed++; out.errors.push(`${m.name}: ${r.error}`); }
      else out.reportsSent++;
    } catch (err) {
      out.reportsFailed++;
      out.errors.push(`${m.name}: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * Hourly tick. Frequencies are day-scale, so the hour is fine granularity and
 * keeps a restart from bunching every alert onto the same minute.
 */
export function scheduleOutreach(intervalMinutes = 60): void {
  const run = () => {
    runOutreach()
      .then((r) => {
        if (r.alertsSent || r.reportsSent) {
          console.log(`[Outreach] sent ${r.alertsSent} listing alert(s), ${r.reportsSent} market report(s)`);
        }
        if (r.errors.length) console.error("[Outreach] problems:", r.errors.slice(0, 5).join(" | "));
      })
      .catch((e) => console.error("[Outreach] run threw:", e));
  };
  setTimeout(run, 90_000);          // let boot and the MLS sync settle first
  setInterval(run, Math.max(5, intervalMinutes) * 60 * 1000);
  console.log(`[Outreach] listing alerts + market reports scheduled every ${intervalMinutes}m`);
}

/** Record a click and mirror it onto the contact's timeline. */
export async function noteEngagement(input: {
  kind: "alert" | "report";
  subscriptionId: string;
  leadId: string;
  event: "email_opened" | "listing_clicked" | "report_viewed";
  listingKey?: string | null;
  description: string;
}): Promise<void> {
  recordEngagement(input);
  /* Opens are noisy — a mail client can prefetch a pixel — so only the
     deliberate actions reach the timeline, where they are read as intent. */
  if (input.event !== "email_opened") await appendTimeline(input.leadId, input.description);
}
