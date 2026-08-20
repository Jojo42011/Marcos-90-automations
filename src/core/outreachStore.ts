/**
 * Listing Alerts and Market Reports — the two client-facing MLS subscriptions.
 *
 * ONE FILE FOR BOTH, on purpose. They are the same subsystem seen from the two
 * sides of the business: a saved MLS search that emails a contact on a
 * schedule, and logs whether the contact engaged. A buyer gets listings, a
 * homeowner gets what their neighbourhood is doing. They share the criteria
 * vocabulary, the send loop, the tracking pixel and the engagement feed, so
 * splitting them across two databases would mean writing all of that twice.
 *
 * WHAT `sent_listings` IS FOR, and why it is not just a timestamp. Brivity's
 * alert fires "the moment a matching listing hits, changes price, or goes
 * pending". A last-sent timestamp cannot express that — a listing whose price
 * dropped yesterday has not changed since the last run by any date comparison,
 * yet it is exactly what the buyer wants to hear about. So each alert keeps the
 * price and status it last told this contact about, per listing, and a row is
 * re-sendable when either has moved. That also makes the common case correct:
 * a listing already sent, unchanged, is never sent twice.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import type { ListingCriteria } from "./listingCriteria.js";

export type AlertFrequency = "daily" | "weekly" | "monthly";
export type ReportFrequency = "monthly" | "quarterly" | "semiannual" | "annual";

export interface ListingAlert {
  id: string;
  leadId: string;
  name: string;
  /** Extra recipient copied on every send (a spouse, or Marco himself). */
  cc: string | null;
  sendEmail: boolean;
  frequency: AlertFrequency;
  criteria: ListingCriteria;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
  lastSentAt: string | null;
  nextSendAt: string | null;
  lastMatchCount: number | null;
  createdBy: string | null;
}

export interface MarketReport {
  id: string;
  leadId: string;
  name: string;
  /** The address the report is about — usually the contact's own home. */
  address: string;
  cc: string | null;
  frequency: ReportFrequency;
  /** false = built and saved, but not on a recurring schedule. */
  drip: boolean;
  criteria: ListingCriteria;
  /**
   * The home itself, as far as we know it. Needed because the value estimate is
   * comparable-based: without the square footage there is no honest way to turn
   * a neighbourhood's price-per-square-foot into a number for THIS house, and
   * the report says so rather than inventing one.
   */
  subject: { sqft?: number; beds?: number; baths?: number; yearBuilt?: number };
  /** Agent's override of the comp-derived estimate, in dollars. */
  adjustedValue: number | null;
  includeHomeValue: boolean;
  /** Custom note that goes out with the FIRST email only. */
  emailMessage: string | null;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
  lastSentAt: string | null;
  nextSendAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  createdBy: string | null;
}

export interface OutreachSend {
  id: string;
  kind: "alert" | "report";
  subscriptionId: string;
  leadId: string;
  sentAt: string;
  listingCount: number;
  ok: boolean;
  error: string | null;
  openedAt: string | null;
  openCount: number;
}

function resolveDbPath(): string {
  const env = process.env.OUTREACH_DB_PATH?.trim();
  if (env) { mkdirSync(path.dirname(env), { recursive: true }); return env; }
  if (existsSync("/data")) return "/data/outreach.db";
  const dir = path.join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "outreach.db");
}

let db: Database.Database | null = null;

export function getOutreachDb(): Database.Database {
  if (db) return db;
  db = new Database(resolveDbPath());
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_alerts (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cc TEXT,
      send_email INTEGER NOT NULL DEFAULT 1,
      frequency TEXT NOT NULL DEFAULT 'daily',
      criteria TEXT NOT NULL DEFAULT '{}',
      paused INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_sent_at TEXT,
      next_send_at TEXT,
      last_match_count INTEGER,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_lead ON listing_alerts(lead_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_next ON listing_alerts(next_send_at);

    CREATE TABLE IF NOT EXISTS market_reports (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      cc TEXT,
      frequency TEXT NOT NULL DEFAULT 'quarterly',
      drip INTEGER NOT NULL DEFAULT 1,
      criteria TEXT NOT NULL DEFAULT '{}',
      subject TEXT NOT NULL DEFAULT '{}',
      adjusted_value REAL,
      include_home_value INTEGER NOT NULL DEFAULT 1,
      email_message TEXT,
      paused INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_sent_at TEXT,
      next_send_at TEXT,
      last_viewed_at TEXT,
      view_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reports_lead ON market_reports(lead_id);
    CREATE INDEX IF NOT EXISTS idx_reports_next ON market_reports(next_send_at);

    /* One row per listing per alert: what this contact has already been told,
       and at what price/status, so a change can re-notify but a repeat cannot. */
    CREATE TABLE IF NOT EXISTS sent_listings (
      alert_id TEXT NOT NULL,
      listing_key TEXT NOT NULL,
      last_price REAL,
      last_status TEXT,
      first_sent_at TEXT NOT NULL,
      last_sent_at TEXT NOT NULL,
      PRIMARY KEY (alert_id, listing_key)
    );

    CREATE TABLE IF NOT EXISTS outreach_sends (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      listing_count INTEGER NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      opened_at TEXT,
      open_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sends_sub ON outreach_sends(subscription_id);
    CREATE INDEX IF NOT EXISTS idx_sends_at ON outreach_sends(sent_at);

    /* Every click-through and report open. This is the buyer/seller
       temperature signal the whole feature exists to produce — a contact who
       keeps opening is the one to call. */
    CREATE TABLE IF NOT EXISTS outreach_engagement (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      event TEXT NOT NULL,
      listing_key TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eng_lead ON outreach_engagement(lead_id);
    CREATE INDEX IF NOT EXISTS idx_eng_sub ON outreach_engagement(subscription_id);
    CREATE INDEX IF NOT EXISTS idx_eng_at ON outreach_engagement(at);
  `);
  return db;
}

const json = <T,>(raw: unknown, fallback: T): T => {
  try { return raw ? (JSON.parse(String(raw)) as T) : fallback; } catch { return fallback; }
};

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/* ---------------------------------------------------------------- alerts -- */

function rowToAlert(r: Record<string, unknown>): ListingAlert {
  return {
    id: String(r.id),
    leadId: String(r.lead_id),
    name: String(r.name),
    cc: r.cc ? String(r.cc) : null,
    sendEmail: Number(r.send_email) === 1,
    frequency: (["daily", "weekly", "monthly"].includes(String(r.frequency)) ? String(r.frequency) : "daily") as AlertFrequency,
    criteria: json<ListingCriteria>(r.criteria, {}),
    paused: Number(r.paused) === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    lastSentAt: r.last_sent_at ? String(r.last_sent_at) : null,
    nextSendAt: r.next_send_at ? String(r.next_send_at) : null,
    lastMatchCount: r.last_match_count == null ? null : Number(r.last_match_count),
    createdBy: r.created_by ? String(r.created_by) : null,
  };
}

export function listAlerts(leadId?: string): ListingAlert[] {
  const db = getOutreachDb();
  const rows = leadId
    ? db.prepare(`SELECT * FROM listing_alerts WHERE lead_id = ? ORDER BY created_at DESC`).all(leadId)
    : db.prepare(`SELECT * FROM listing_alerts ORDER BY created_at DESC`).all();
  return (rows as Record<string, unknown>[]).map(rowToAlert);
}

export function getAlert(id: string): ListingAlert | null {
  const r = getOutreachDb().prepare(`SELECT * FROM listing_alerts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? rowToAlert(r) : null;
}

export function insertAlert(a: ListingAlert): ListingAlert {
  getOutreachDb()
    .prepare(
      `INSERT INTO listing_alerts (id, lead_id, name, cc, send_email, frequency, criteria, paused,
         created_at, updated_at, last_sent_at, next_send_at, last_match_count, created_by)
       VALUES (@id,@leadId,@name,@cc,@sendEmail,@frequency,@criteria,@paused,
         @createdAt,@updatedAt,@lastSentAt,@nextSendAt,@lastMatchCount,@createdBy)`,
    )
    .run({
      ...a,
      sendEmail: a.sendEmail ? 1 : 0,
      paused: a.paused ? 1 : 0,
      criteria: JSON.stringify(a.criteria ?? {}),
    });
  return a;
}

const ALERT_COLS: Record<string, string> = {
  name: "name", cc: "cc", sendEmail: "send_email", frequency: "frequency",
  criteria: "criteria", paused: "paused", lastSentAt: "last_sent_at",
  nextSendAt: "next_send_at", lastMatchCount: "last_match_count",
};

export function updateAlert(id: string, patch: Partial<ListingAlert>): ListingAlert | null {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updatedAt: new Date().toISOString() };
  for (const [key, col] of Object.entries(ALERT_COLS)) {
    if (!(key in patch)) continue;
    const v = (patch as Record<string, unknown>)[key];
    sets.push(`${col} = @${key}`);
    params[key] = key === "criteria" ? JSON.stringify(v ?? {})
      : typeof v === "boolean" ? (v ? 1 : 0)
      : v ?? null;
  }
  if (!sets.length) return getAlert(id);
  getOutreachDb().prepare(`UPDATE listing_alerts SET ${sets.join(", ")}, updated_at = @updatedAt WHERE id = @id`).run(params);
  return getAlert(id);
}

export function deleteAlert(id: string): boolean {
  const db = getOutreachDb();
  const res = db.prepare(`DELETE FROM listing_alerts WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM sent_listings WHERE alert_id = ?`).run(id);
  return res.changes > 0;
}

/** Alerts whose next send is due (or overdue), skipping paused ones. */
export function dueAlerts(now = new Date().toISOString()): ListingAlert[] {
  const rows = getOutreachDb()
    .prepare(`SELECT * FROM listing_alerts WHERE paused = 0 AND send_email = 1
              AND (next_send_at IS NULL OR next_send_at <= ?) ORDER BY next_send_at`)
    .all(now) as Record<string, unknown>[];
  return rows.map(rowToAlert);
}

/* ------------------------------------------------------- sent listings --- */

export interface SentListingRow { listingKey: string; lastPrice: number | null; lastStatus: string | null }

export function sentListingsFor(alertId: string): Map<string, SentListingRow> {
  const rows = getOutreachDb()
    .prepare(`SELECT listing_key, last_price, last_status FROM sent_listings WHERE alert_id = ?`)
    .all(alertId) as Record<string, unknown>[];
  const out = new Map<string, SentListingRow>();
  for (const r of rows) {
    out.set(String(r.listing_key), {
      listingKey: String(r.listing_key),
      lastPrice: r.last_price == null ? null : Number(r.last_price),
      lastStatus: r.last_status == null ? null : String(r.last_status),
    });
  }
  return out;
}

export function recordSentListings(
  alertId: string,
  rows: Array<{ listingKey: string; price: number | null; status: string | null }>,
  at = new Date().toISOString(),
): void {
  const db = getOutreachDb();
  const stmt = db.prepare(
    `INSERT INTO sent_listings (alert_id, listing_key, last_price, last_status, first_sent_at, last_sent_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(alert_id, listing_key) DO UPDATE SET
       last_price = excluded.last_price, last_status = excluded.last_status, last_sent_at = excluded.last_sent_at`,
  );
  const tx = db.transaction((list: typeof rows) => {
    for (const r of list) stmt.run(alertId, r.listingKey, r.price, r.status, at, at);
  });
  tx(rows);
}

/* --------------------------------------------------------------- reports -- */

function rowToReport(r: Record<string, unknown>): MarketReport {
  const freq = String(r.frequency);
  return {
    id: String(r.id),
    leadId: String(r.lead_id),
    name: String(r.name),
    address: String(r.address),
    cc: r.cc ? String(r.cc) : null,
    frequency: (["monthly", "quarterly", "semiannual", "annual"].includes(freq) ? freq : "quarterly") as ReportFrequency,
    drip: Number(r.drip) === 1,
    criteria: json<ListingCriteria>(r.criteria, {}),
    subject: json<MarketReport["subject"]>(r.subject, {}),
    adjustedValue: r.adjusted_value == null ? null : Number(r.adjusted_value),
    includeHomeValue: Number(r.include_home_value) === 1,
    emailMessage: r.email_message ? String(r.email_message) : null,
    paused: Number(r.paused) === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    lastSentAt: r.last_sent_at ? String(r.last_sent_at) : null,
    nextSendAt: r.next_send_at ? String(r.next_send_at) : null,
    lastViewedAt: r.last_viewed_at ? String(r.last_viewed_at) : null,
    viewCount: Number(r.view_count || 0),
    createdBy: r.created_by ? String(r.created_by) : null,
  };
}

export function listReports(leadId?: string): MarketReport[] {
  const db = getOutreachDb();
  const rows = leadId
    ? db.prepare(`SELECT * FROM market_reports WHERE lead_id = ? ORDER BY created_at DESC`).all(leadId)
    : db.prepare(`SELECT * FROM market_reports ORDER BY created_at DESC`).all();
  return (rows as Record<string, unknown>[]).map(rowToReport);
}

export function getReport(id: string): MarketReport | null {
  const r = getOutreachDb().prepare(`SELECT * FROM market_reports WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? rowToReport(r) : null;
}

export function insertReport(m: MarketReport): MarketReport {
  getOutreachDb()
    .prepare(
      `INSERT INTO market_reports (id, lead_id, name, address, cc, frequency, drip, criteria, subject, adjusted_value,
         include_home_value, email_message, paused, created_at, updated_at, last_sent_at, next_send_at,
         last_viewed_at, view_count, created_by)
       VALUES (@id,@leadId,@name,@address,@cc,@frequency,@drip,@criteria,@subject,@adjustedValue,
         @includeHomeValue,@emailMessage,@paused,@createdAt,@updatedAt,@lastSentAt,@nextSendAt,
         @lastViewedAt,@viewCount,@createdBy)`,
    )
    .run({
      ...m,
      drip: m.drip ? 1 : 0,
      paused: m.paused ? 1 : 0,
      includeHomeValue: m.includeHomeValue ? 1 : 0,
      criteria: JSON.stringify(m.criteria ?? {}),
      subject: JSON.stringify(m.subject ?? {}),
    });
  return m;
}

const REPORT_COLS: Record<string, string> = {
  name: "name", address: "address", cc: "cc", frequency: "frequency", drip: "drip",
  criteria: "criteria", subject: "subject", adjustedValue: "adjusted_value", includeHomeValue: "include_home_value",
  emailMessage: "email_message", paused: "paused", lastSentAt: "last_sent_at",
  nextSendAt: "next_send_at", lastViewedAt: "last_viewed_at", viewCount: "view_count",
};

export function updateReport(id: string, patch: Partial<MarketReport>): MarketReport | null {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updatedAt: new Date().toISOString() };
  for (const [key, col] of Object.entries(REPORT_COLS)) {
    if (!(key in patch)) continue;
    const v = (patch as Record<string, unknown>)[key];
    sets.push(`${col} = @${key}`);
    params[key] = key === "criteria" || key === "subject" ? JSON.stringify(v ?? {})
      : typeof v === "boolean" ? (v ? 1 : 0)
      : v ?? null;
  }
  if (!sets.length) return getReport(id);
  getOutreachDb().prepare(`UPDATE market_reports SET ${sets.join(", ")}, updated_at = @updatedAt WHERE id = @id`).run(params);
  return getReport(id);
}

export function deleteReport(id: string): boolean {
  return getOutreachDb().prepare(`DELETE FROM market_reports WHERE id = ?`).run(id).changes > 0;
}

export function dueReports(now = new Date().toISOString()): MarketReport[] {
  const rows = getOutreachDb()
    .prepare(`SELECT * FROM market_reports WHERE paused = 0 AND drip = 1
              AND next_send_at IS NOT NULL AND next_send_at <= ? ORDER BY next_send_at`)
    .all(now) as Record<string, unknown>[];
  return rows.map(rowToReport);
}

/* ----------------------------------------------------- sends + tracking --- */

export function recordSend(s: Omit<OutreachSend, "openedAt" | "openCount">): OutreachSend {
  const row: OutreachSend = { ...s, openedAt: null, openCount: 0 };
  getOutreachDb()
    .prepare(
      `INSERT INTO outreach_sends (id, kind, subscription_id, lead_id, sent_at, listing_count, ok, error, opened_at, open_count)
       VALUES (@id,@kind,@subscriptionId,@leadId,@sentAt,@listingCount,@ok,@error,NULL,0)`,
    )
    .run({ ...row, ok: row.ok ? 1 : 0 });
  return row;
}

export function listSends(subscriptionId: string, limit = 25): OutreachSend[] {
  const rows = getOutreachDb()
    .prepare(`SELECT * FROM outreach_sends WHERE subscription_id = ? ORDER BY sent_at DESC LIMIT ?`)
    .all(subscriptionId, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind === "report" ? "report" : "alert",
    subscriptionId: String(r.subscription_id),
    leadId: String(r.lead_id),
    sentAt: String(r.sent_at),
    listingCount: Number(r.listing_count || 0),
    ok: Number(r.ok) === 1,
    error: r.error ? String(r.error) : null,
    openedAt: r.opened_at ? String(r.opened_at) : null,
    openCount: Number(r.open_count || 0),
  }));
}

export function markSendOpened(sendId: string, at = new Date().toISOString()): void {
  getOutreachDb()
    .prepare(`UPDATE outreach_sends SET opened_at = COALESCE(opened_at, ?), open_count = open_count + 1 WHERE id = ?`)
    .run(at, sendId);
}

export type EngagementEvent = "email_opened" | "listing_clicked" | "report_viewed";

export function recordEngagement(e: {
  kind: "alert" | "report";
  subscriptionId: string;
  leadId: string;
  event: EngagementEvent;
  listingKey?: string | null;
  at?: string;
}): void {
  getOutreachDb()
    .prepare(`INSERT INTO outreach_engagement (id, kind, subscription_id, lead_id, event, listing_key, at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(newId("eng"), e.kind, e.subscriptionId, e.leadId, e.event, e.listingKey ?? null, e.at ?? new Date().toISOString());
}

export interface EngagementRow {
  id: string; kind: "alert" | "report"; subscriptionId: string; leadId: string;
  event: string; listingKey: string | null; at: string;
}

export function engagementForLead(leadId: string, limit = 50): EngagementRow[] {
  const rows = getOutreachDb()
    .prepare(`SELECT * FROM outreach_engagement WHERE lead_id = ? ORDER BY at DESC LIMIT ?`)
    .all(leadId, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind === "report" ? "report" : "alert",
    subscriptionId: String(r.subscription_id),
    leadId: String(r.lead_id),
    event: String(r.event),
    listingKey: r.listing_key ? String(r.listing_key) : null,
    at: String(r.at),
  }));
}

/** Engagement counts per lead since a date — the "who is getting serious" list. */
export function hotEngagement(sinceIso: string, limit = 50): Array<{ leadId: string; events: number; lastAt: string }> {
  const rows = getOutreachDb()
    .prepare(`SELECT lead_id, COUNT(*) n, MAX(at) last_at FROM outreach_engagement
              WHERE at >= ? GROUP BY lead_id ORDER BY n DESC, last_at DESC LIMIT ?`)
    .all(sinceIso, limit) as Record<string, unknown>[];
  return rows.map((r) => ({ leadId: String(r.lead_id), events: Number(r.n), lastAt: String(r.last_at) }));
}

export function outreachCounts(): { alerts: number; reports: number; sends: number; engagements: number } {
  const db = getOutreachDb();
  const one = (sql: string) => Number((db.prepare(sql).get() as { n: number })?.n || 0);
  return {
    alerts: one(`SELECT COUNT(*) n FROM listing_alerts`),
    reports: one(`SELECT COUNT(*) n FROM market_reports`),
    sends: one(`SELECT COUNT(*) n FROM outreach_sends`),
    engagements: one(`SELECT COUNT(*) n FROM outreach_engagement`),
  };
}

/**
 * One pass over the whole outreach mirror, keyed by lead.
 *
 * The CRM lead table sorts and columns on these, so a per-lead query would be
 * one round trip per row on a 1,300-contact board. Everything here is a real
 * measurement — an alert that exists, an email that was actually sent, an open
 * pixel that actually fired — so a lead with no row is a lead with no outreach,
 * not a lead we failed to look up.
 */
export interface LeadOutreachSummary {
  listingAlerts: number;
  marketReports: number;
  lastSentAt: string | null;
  lastOpenedAlertAt: string | null;
  lastOpenedReportAt: string | null;
}

export function outreachSummaryByLead(): Map<string, LeadOutreachSummary> {
  const d = getOutreachDb();
  const out = new Map<string, LeadOutreachSummary>();
  const bump = (leadId: string): LeadOutreachSummary => {
    let row = out.get(leadId);
    if (!row) {
      row = { listingAlerts: 0, marketReports: 0, lastSentAt: null, lastOpenedAlertAt: null, lastOpenedReportAt: null };
      out.set(leadId, row);
    }
    return row;
  };
  const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

  for (const r of d.prepare(`SELECT lead_id, COUNT(*) n FROM listing_alerts GROUP BY lead_id`).all() as Array<{ lead_id: string; n: number }>) {
    bump(String(r.lead_id)).listingAlerts = Number(r.n) || 0;
  }
  for (const r of d.prepare(`SELECT lead_id, COUNT(*) n FROM market_reports GROUP BY lead_id`).all() as Array<{ lead_id: string; n: number }>) {
    bump(String(r.lead_id)).marketReports = Number(r.n) || 0;
  }
  const sends = d
    .prepare(
      `SELECT lead_id, kind, MAX(sent_at) AS last_sent, MAX(opened_at) AS last_opened
       FROM outreach_sends WHERE ok = 1 GROUP BY lead_id, kind`,
    )
    .all() as Array<{ lead_id: string; kind: string; last_sent: string | null; last_opened: string | null }>;
  for (const r of sends) {
    const row = bump(String(r.lead_id));
    row.lastSentAt = later(row.lastSentAt, r.last_sent);
    if (String(r.kind) === "alert") row.lastOpenedAlertAt = later(row.lastOpenedAlertAt, r.last_opened);
    else row.lastOpenedReportAt = later(row.lastOpenedReportAt, r.last_opened);
  }
  return out;
}
