import { fetchProperties, isMlsFeedConfigured, simplyRetsConfig } from "../../integrations/simplyrets/index.js";
import {
  finishSyncRun,
  getBackfillState,
  setBackfillState,
  fromSimplyRets,
  lastSuccessfulSync,
  listingCounts,
  newestModificationTs,
  recentSyncRuns,
  startSyncRun,
  upsertListings,
} from "../../core/listingsStore.js";

/**
 * Keeps the local MLS mirror current.
 *
 * INCREMENTAL BY DESIGN. SimplyRETS has no "modified since" filter, so each run
 * walks the feed newest-change-first (`sort=-modified`) and stops the moment it
 * reaches a listing it already holds. The first run does the heavy pull; every
 * run after it reads a page or two, which is what makes a 30-minute cadence
 * affordable against a metered, rate-limited feed.
 *
 * Every attempt is recorded, successes and failures alike. A feed that quietly
 * stopped returning data looks exactly like a quiet market from the dashboard,
 * and the only way to tell them apart is a visible last-successful-sync time.
 */

const SYNC_INTERVAL_MS = 30 * 60 * 1000;
/** First run pulls more, since it is building the mirror from nothing. */
const FIRST_RUN_MAX = 5000;
const INCREMENTAL_MAX = 2000;

let running = false;

export interface MlsSyncResult {
  ran: boolean;
  ok?: boolean;
  phase?: "backfill" | "incremental";
  backfillComplete?: boolean;
  fetched?: number;
  upserted?: number;
  truncated?: boolean;
  error?: string;
  fix?: string;
}

export async function runMlsSync(): Promise<MlsSyncResult> {
  if (!isMlsFeedConfigured()) {
    const cfg = simplyRetsConfig();
    const problem = "ok" in cfg ? cfg : { error: "MLS feed is not configured.", fix: undefined };
    return { ran: false, ok: false, error: problem.error, fix: problem.fix };
  }
  /* Overlapping runs would double-fetch a metered feed and interleave writes
     for no benefit; a skipped tick costs nothing because the next one resumes
     from the same high-water mark. */
  if (running) return { ran: false, error: "A sync is already in progress." };
  running = true;

  const backfill = getBackfillState();
  const since = newestModificationTs();
  const runId = startSyncRun();
  try {
    /* Two phases. Until the board has been walked to the bottom once, keep
       paging DOWNWARD from where the last run stopped; a top-walk would halt at
       record #1 every time and the older half of the board would never arrive.
       Once a page comes back empty the mirror is complete and every later run
       is a cheap top-walk that stops at the first listing already held. */
    const res = backfill.complete
      ? await fetchProperties({ stopAtModified: since, maxRecords: INCREMENTAL_MAX })
      : await fetchProperties({ offset: backfill.offset, maxRecords: FIRST_RUN_MAX });
    if ("error" in res) {
      finishSyncRun(runId, { ok: false, error: res.error });
      console.error("[MlsSync] failed:", res.error);
      return { ran: true, ok: false, error: res.error, fix: res.fix };
    }
    const rows = res.records
      .map(fromSimplyRets)
      .filter((r) => r.listingKey);
    const upserted = upsertListings(rows);

    let phase: "backfill" | "incremental" = backfill.complete ? "incremental" : "backfill";
    if (!backfill.complete) {
      if (res.exhausted) {
        setBackfillState({ complete: true, offset: 0 });
        phase = "backfill";
        console.log("[MlsSync] Backfill complete — switching to incremental top-walk.");
      } else {
        setBackfillState({ offset: backfill.offset + res.records.length });
      }
    }

    finishSyncRun(runId, { ok: true, fetched: res.records.length, upserted });
    console.log(
      `[MlsSync] ${phase}: ${res.records.length} fetched, ${upserted} stored` +
        (res.truncated ? " (capped — next run resumes)" : ""),
    );
    return {
      ran: true,
      ok: true,
      phase,
      backfillComplete: getBackfillState().complete,
      fetched: res.records.length,
      upserted,
      truncated: res.truncated,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishSyncRun(runId, { ok: false, error: message });
    console.error("[MlsSync] crashed:", message);
    return { ran: true, ok: false, error: message };
  } finally {
    running = false;
  }
}

/**
 * Status an operator can act on.
 *
 * Reports staleness as a NUMBER OF HOURS rather than a boolean, because "is the
 * MLS working" has a different answer at two hours and at eleven days, and a
 * green tick would hide the difference.
 */
export function mlsStatus(): Record<string, unknown> {
  const configured = isMlsFeedConfigured();
  const cfg = simplyRetsConfig();
  const counts = listingCounts();
  const last = lastSuccessfulSync();
  const ageHours = last?.finishedAt
    ? (Date.now() - new Date(last.finishedAt).getTime()) / 3_600_000
    : null;
  const backfill = getBackfillState();
  return {
    configured,
    /* An in-progress backfill is NOT a complete picture of the market, and a
       listing count on its own would imply it is. */
    mirrorComplete: backfill.complete,
    ...(backfill.complete ? {} : { backfillOffset: backfill.offset }),
    ...(configured ? {} : { error: "ok" in cfg ? cfg.error : undefined, fix: "ok" in cfg ? cfg.fix : undefined }),
    vendor: configured && !("ok" in cfg) ? cfg.vendor : null,
    listings: counts.total,
    byStatus: counts.byStatus,
    lastSuccessfulSyncAt: last?.finishedAt ?? null,
    hoursSinceLastSync: ageHours == null ? null : Math.round(ageHours * 10) / 10,
    stale: ageHours == null ? true : ageHours > 6,
    recentRuns: recentSyncRuns(5),
    note: configured
      ? counts.total === 0
        ? "Configured but nothing stored yet — run a sync."
        : backfill.complete
          ? undefined
          : `Backfill still running (${counts.total} listings so far). Searches work but do NOT yet cover the whole board.`
      : "Not connected to the MLS feed. Listing tools will say so rather than return an empty market.",
  };
}

export function scheduleMlsSync(): void {
  if (!isMlsFeedConfigured()) {
    console.log("[MlsSync] Not scheduled — MLS feed is not configured (SIMPLYRETS_USERNAME / SIMPLYRETS_PASSWORD).");
    return;
  }
  /* Delayed so the first pull does not compete with boot, and so a crash-loop
     cannot hammer a metered API once per restart. */
  setTimeout(() => void runMlsSync(), 90 * 1000);
  setInterval(() => void runMlsSync(), SYNC_INTERVAL_MS);
  console.log(`[MlsSync] Scheduled — first pull in 90s, then every ${SYNC_INTERVAL_MS / 60000} min`);
}
