"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordGateDecision = recordGateDecision;
exports.gateReport = gateReport;
const LEDGER = [];
const MAX = 400;
/** When the process started, so "0 events" can be read against real uptime. */
const STARTED_AT = new Date().toISOString();
function recordGateDecision(d) {
    LEDGER.push({ at: new Date().toISOString(), ...d, preview: d.preview.slice(0, 80) });
    if (LEDGER.length > MAX)
        LEDGER.splice(0, LEDGER.length - MAX);
}
function gateReport(sinceMinutes = 120) {
    const cutoff = Date.now() - sinceMinutes * 60_000;
    const rows = LEDGER.filter((e) => new Date(e.at).getTime() >= cutoff);
    const byOutcome = {};
    for (const r of rows)
        byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
    const ungated = (byOutcome.fail_open || 0) + (byOutcome.skipped_prev_out || 0) +
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
