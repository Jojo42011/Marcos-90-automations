/**
 * A bounded record of how the DM agent's intent gate decided, and why.
 *
 * WHY THIS EXISTS. "The agent is replying to anybody" is a symptom with several
 * possible causes that look identical from outside, and the logs that would tell
 * them apart are on a host the operator may not be able to reach:
 *
 *   allowed_by_model   — the classifier looked and said yes
 *   rejected_by_model  — the classifier looked and said no (the healthy "no reply")
 *   fail_open          — the API call FAILED and the gate waved it through by design
 *   skipped_prev_out   — the gate was not consulted at all, because the inbound
 *                        payload carried a `marco_previous_outbound` value
 *   skipped_wave       — a wave-only message, always treated as interested
 *   short_circuit      — the deterministic short-message rules answered without the API
 *
 * The distinction that matters most is `skipped_prev_out`. That branch is
 * controlled entirely by a field ManyChat sends: when it is present on a TikTok
 * or Instagram DM, the gate is bypassed and EVERY new contact gets a reply
 * regardless of what they wrote. A change in the ManyChat flow — not in this
 * codebase — is therefore enough to make the agent answer everyone, which is
 * exactly the reported symptom and would leave no trace anywhere else.
 *
 * In-memory and capped, so it costs nothing and resets on deploy. That is the
 * right lifetime for "what is happening right now"; it is deliberately NOT a
 * historical record, and the endpoint that reads it says so.
 */

export type GateOutcome =
  | "allowed_by_model"
  | "rejected_by_model"
  | "fail_open"
  | "skipped_prev_out"
  | "skipped_wave"
  | "short_circuit"
  /* Replied WITHOUT reaching the gate at all: the pipeline has canned redirects
     for realtors, business pitches and explicit declines, each of which returns
     a reply before the gate is consulted. These are working as designed, but
     they are indistinguishable from a bug to anyone watching the inbox — the
     agent is visibly answering people who are plainly not buyers. */
  | "canned_redirect";

export interface GateDecision {
  at: string;
  outcome: GateOutcome;
  /** For canned redirects, which one — realtor, business pitch, decline. */
  reason?: string;
  replied: boolean;
  platform: string;
  channel: string;
  /** First few words only — enough to recognise a pattern, not a message store. */
  preview: string;
}

const LEDGER: GateDecision[] = [];
const MAX = 400;
/** When the process started, so "0 events" can be read against real uptime. */
const STARTED_AT = new Date().toISOString();

export function recordGateDecision(d: Omit<GateDecision, "at">): void {
  LEDGER.push({ at: new Date().toISOString(), ...d, preview: d.preview.slice(0, 80) });
  if (LEDGER.length > MAX) LEDGER.splice(0, LEDGER.length - MAX);
}

export interface GateReport {
  startedAt: string;
  uptimeMinutes: number;
  sinceMinutes: number;
  total: number;
  replied: number;
  byOutcome: Record<string, number>;
  /** Share of decisions that were NOT an actual judgement, 0-1. */
  ungatedShare: number;
  recent: GateDecision[];
}

export function gateReport(sinceMinutes = 120): GateReport {
  const cutoff = Date.now() - sinceMinutes * 60_000;
  const rows = LEDGER.filter((e) => new Date(e.at).getTime() >= cutoff);
  const byOutcome: Record<string, number> = {};
  for (const r of rows) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
  const ungated =
    (byOutcome.fail_open || 0) + (byOutcome.skipped_prev_out || 0) +
    (byOutcome.skipped_wave || 0) + (byOutcome.canned_redirect || 0);
  return {
    startedAt: STARTED_AT,
    uptimeMinutes: Math.round((Date.now() - new Date(STARTED_AT).getTime()) / 60_000),
    sinceMinutes,
    total: rows.length,
    replied: rows.filter((r) => r.replied).length,
    byOutcome,
    ungatedShare: rows.length ? Math.round((ungated / rows.length) * 100) / 100 : 0,
    recent: rows.slice(-30).reverse(),
  };
}
