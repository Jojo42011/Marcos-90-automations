import type { DashboardLeadRow, LeadFilter } from "./types.js";
import { normalizeCrmIntent, normalizeCrmStatus } from "./db.js";
import { getDashboardSnapshot } from "./db.js";

function parseRangeBound(iso: string, endOfDay: boolean): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function inDateRange(ts: string | null | undefined, from?: string, to?: string): boolean {
  if (!from && !to) return true;
  if (!ts) return false;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return false;
  if (from) {
    const f = parseRangeBound(from, false);
    if (f !== null && t < f) return false;
  }
  if (to) {
    const e = parseRangeBound(to, true);
    if (e !== null && t > e) return false;
  }
  return true;
}

function normalizeFilterSource(label: string): string {
  return label.trim().toLowerCase();
}

function leadMatchesSource(row: DashboardLeadRow, sources: string[]): boolean {
  const plat = String(row.platform || "").toLowerCase();
  const src = String(row.source || "").toLowerCase();
  return sources.some((raw) => {
    const s = normalizeFilterSource(raw);
    if (s === "instagram" || s === "ig") return plat.includes("insta") || src.includes("insta");
    if (s === "tiktok" || s === "tik") return plat.includes("tik") || src.includes("tik");
    if (s === "manual") return plat === "manual" || src === "manual";
    return src.includes(s) || plat.includes(s);
  });
}

/** Apply LeadFilter with AND logic across fields. */
export function applyLeadFilter(rows: DashboardLeadRow[], filter: LeadFilter): DashboardLeadRow[] {
  return rows.filter((row) => {
    if (filter.intent) {
      const intent = normalizeCrmIntent(row.crmIntent);
      if (intent !== filter.intent) return false;
    }
    if (filter.status?.length) {
      const st = normalizeCrmStatus(row.crmStatus);
      if (!filter.status.some((s) => normalizeCrmStatus(s) === st)) return false;
    }
    if (filter.source?.length && !leadMatchesSource(row, filter.source)) return false;
    if (filter.stage?.length) {
      const stage = row.crmStage || "new";
      if (!filter.stage.includes(stage)) return false;
    }
    if (filter.tags?.length) {
      const tags = row.tags || [];
      if (!filter.tags.some((t) => tags.includes(t))) return false;
    }
    if (!inDateRange(row.createdAt, filter.dateAddedFrom, filter.dateAddedTo)) return false;
    if (!inDateRange(row.lastActivity, filter.lastContactFrom, filter.lastContactTo)) return false;
    if (filter.assignedUser) {
      const uid = filter.assignedUser.trim();
      if (uid && uid !== "all" && (row.assignedUserId || "") !== uid) return false;
    }
    return true;
  });
}

export async function filterDashboardLeads(filter: LeadFilter): Promise<DashboardLeadRow[]> {
  const snap = await getDashboardSnapshot();
  return applyLeadFilter(snap.leads, filter);
}
