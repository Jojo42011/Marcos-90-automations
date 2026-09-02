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
exports.phoneKey = phoneKey;
exports.planBrivityImport = planBrivityImport;
exports.applyBrivityImport = applyBrivityImport;
exports.leadFromPlannedCreate = leadFromPlannedCreate;
const state_js_1 = require("./state.js");
const brivityPeople_js_1 = require("./brivityPeople.js");
const db_js_1 = require("./db.js");
const contactRecordStore_js_1 = require("./contactRecordStore.js");
/**
 * Plan (and later apply) an import of Marco's real Brivity contacts into the
 * lead store, so they reach the CRM and the Buyers & Sellers Tracker.
 *
 * Brivity is already readable — `brivityPeople.ts` fetches and caches it for
 * /crm — but nothing has ever been persisted, which is why no lead carries a
 * `brivityId`. This module is the missing write half.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS DOES NOT CALL createLead()
 *
 * `db.createLead()` fires real outbound side effects: a phone on the lead sends
 * a Twilio SMS to Marco and Carlos, and an email schedules a marketing
 * auto-reply three minutes later plus a buyer/seller drip. Pushing ~2,470
 * phones and ~986 emails through it would text the two of them thousands of
 * times and email a thousand mostly-cold contacts unprompted.
 *
 * The apply step therefore writes through `importLeadQuiet()`, which inserts
 * the same record with none of that. These are existing contacts being filed,
 * not new leads arriving.
 * ────────────────────────────────────────────────────────────────────────────
 */
/** Match key: US 10-digit, so "(210) 555-0134", "+12105550134" and "2105550134" agree. */
function phoneKey(raw) {
    let d = String(raw ?? "").replace(/\D/g, "");
    if (d.length === 11 && d.startsWith("1"))
        d = d.slice(1);
    return d.length === 10 ? d : "";
}
function emailKey(raw) {
    return String(raw ?? "").trim().toLowerCase();
}
/** An all-caps or all-lower Brivity name reads badly on a card. */
function tidyName(raw) {
    const s = String(raw ?? "").trim().replace(/\s+/g, " ");
    if (!s)
        return "";
    if (s !== s.toUpperCase() && s !== s.toLowerCase())
        return s; // already mixed case
    return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
/** Names Brivity uses as filler; not worth overwriting a real handle with. */
const JUNK_NAMES = new Set(["", "unknown", "n/a", "na", "none", "no name", "-"]);
function usableName(raw) {
    const s = tidyName(raw);
    return JUNK_NAMES.has(s.toLowerCase()) ? "" : s;
}
/**
 * What a contact is called on a card when Brivity has no name for them — 339 of
 * the 2,727 leads, almost all inbound calls that were never named.
 *
 * The fallback is their phone number, which is genuinely the most useful handle
 * for a phone-only contact. It is FORMATTED, though: a bare "7863760614" in a
 * name column reads as a data error, while "(786) 376-0614" reads as what it
 * is. Email is next, and only then a placeholder — but "Unnamed" for every one
 * of them would make 339 contacts indistinguishable from each other.
 */
function displayName(p) {
    const real = usableName(p.name);
    if (real)
        return real;
    if (p.phone)
        return (0, contactRecordStore_js_1.formatUsPhone)(p.phone);
    if (p.email)
        return p.email;
    return "Unnamed contact";
}
/**
 * Statuses that take a lead off the working board. Brivity may hold any of
 * these for a contact this CRM is actively talking to, and importing one would
 * hide a live conversation, so none of them is ever merged onto an existing
 * lead. They are still honoured for CREATES — a contact we have never spoken to
 * belongs in whatever bucket Brivity had it in.
 */
const BURYING_STATUSES = new Set(["dead", "archived", "trashed"]);
/** Brivity status → the CRM's status vocabulary, already normalised upstream. */
function statusOf(p) {
    return (p.crmStatus || "new");
}
/**
 * Brivity's intention, or null when it never said.
 *
 * The previous version returned "buyer" for anything that was not "seller",
 * which invented an intention for the 1,353 contacts Brivity marks "n/a" and
 * silently downgraded the 202 marked "seller/buyer". Null is carried through so
 * the merge path can decline to overwrite what we already know.
 */
function intentOf(p) {
    return p.crmIntent ?? null;
}
/**
 * Pick the better of two Brivity rows sharing a phone: the one with more filled
 * fields.
 *
 * There is no recency tie-break, because there is nothing to break it with —
 * Brivity's people API returns no timestamps at all, so `updatedAt` is always
 * null. A tie therefore keeps the row seen first, which at least makes the
 * outcome deterministic across runs rather than dependent on fetch order.
 */
function richer(a, b) {
    const score = (x) => (usableName(x.name) ? 2 : 0) + (x.email ? 1 : 0) + (x.phone ? 1 : 0) + (x.source ? 1 : 0);
    const sa = score(a), sb = score(b);
    return sb > sa ? b : a;
}
async function planBrivityImport(opts = {}, deps = {}) {
    const options = {
        includeDead: opts.includeDead === true,
        enrichDeadMatches: opts.enrichDeadMatches !== false,
        preferBrivityName: opts.preferBrivityName !== false,
        includeNonLeads: opts.includeNonLeads === true,
    };
    /*
     * "Not connected" and "connected but empty" are different problems with
     * different fixes, and getBrivityPeople() cannot tell them apart — it returns
     * [] for an unconfigured server on purpose, so the CRM degrades quietly
     * rather than erroring on every page load. For a MIGRATION that quiet is
     * dangerous: reported as "no contacts to import", a missing server key reads
     * as "Brivity is empty" and would be acted on as though the job were done.
     * So the key is checked here, before the fetch, and named.
     */
    if (!deps.fetchPeople && !(0, brivityPeople_js_1.brivityConfigured)()) {
        throw new Error("BRIVITY_API_KEY is not set on this server, so nothing can be read from Brivity — " +
            "neither the live contact list nor a migration plan. This is not an empty Brivity " +
            "account and not a fault in the migration. Set it as a secret on the Fly app " +
            "(flyctl secrets set BRIVITY_API_KEY=…) and try again.");
    }
    const people = deps.fetchPeople ? await deps.fetchPeople() : await (0, brivityPeople_js_1.getBrivityPeople)(false);
    /*
     * getBrivityPeople swallows fetch failures and returns [] (it is built to
     * degrade for the CRM view). For an import plan that is dangerous: an empty
     * result would read as "nothing to import" when it actually means "we could
     * not reach Brivity". Refuse rather than report a false no-op.
     */
    if (!people.length) {
        const st = (0, brivityPeople_js_1.getBrivityImportStatus)();
        throw new Error(st.lastError
            ? `Brivity fetch failed (${st.lastError}) — refusing to plan against an empty result`
            : "Brivity returned no contacts — refusing to plan against an empty result");
    }
    const leads = deps.loadLeads ? deps.loadLeads() : await (0, db_js_1.listAllLeads)();
    // Existing leads indexed for matching. A phone shared by two leads is a
    // conflict we refuse to guess at rather than merging into the wrong one.
    const byPhone = new Map();
    const byEmail = new Map();
    const byBrivityId = new Map();
    for (const l of leads) {
        const pk = phoneKey(l.phone);
        if (pk) {
            const arr = byPhone.get(pk) || [];
            arr.push(l);
            byPhone.set(pk, arr);
        }
        const ek = emailKey(l.email);
        if (ek && !byEmail.has(ek))
            byEmail.set(ek, l);
        if (l.brivityId)
            byBrivityId.set(String(l.brivityId), l);
    }
    const plan = {
        dryRun: opts.dryRun !== false,
        options,
        fetched: people.length,
        skipped: { dead: 0, noContactInfo: 0, duplicateWithinBrivity: 0, nonLead: 0 },
        creates: [],
        merges: [],
        unchanged: 0,
        ambiguous: [],
        counts: { create: 0, merge: 0, renames: 0 },
    };
    // Collapse duplicates inside Brivity itself before matching outward.
    /*
     * Dead contacts are held back from CREATE, not from matching. Dropping them
     * outright also drops the enrichment for leads we already have: 134 of them
     * match a dead Brivity contact and 114 are on the board under a social handle
     * when Brivity knows the real name. Enrichment adds no rows.
     */
    const chosen = new Map();
    for (const p of people) {
        const pk = phoneKey(p.phone);
        const ek = emailKey(p.email);
        if (!pk && !ek) {
            plan.skipped.noContactInfo++;
            continue;
        }
        const key = pk || `e:${ek}`;
        const prev = chosen.get(key);
        if (prev) {
            plan.skipped.duplicateWithinBrivity++;
            chosen.set(key, richer(prev, p));
        }
        else
            chosen.set(key, p);
    }
    for (const p of chosen.values()) {
        const pk = phoneKey(p.phone);
        const ek = emailKey(p.email);
        const bid = String(p.brivityId || p.id || "");
        let match = bid ? byBrivityId.get(bid) : undefined;
        let matchedOn = "phone";
        if (!match && pk) {
            const hits = byPhone.get(pk) || [];
            if (hits.length > 1) {
                plan.ambiguous.push({
                    brivityId: bid,
                    name: usableName(p.name) || "(no name)",
                    phone: pk,
                    leadIds: hits.map((h) => h.id),
                });
                continue;
            }
            match = hits[0];
        }
        if (!match && ek) {
            match = byEmail.get(ek);
            matchedOn = "email";
        }
        const isDead = statusOf(p) === "dead";
        /* `lead` is the only Brivity type that is a contact. `collaborator` and
           `team` are lenders, co-op agents and Marco's own staff seats; `unknown`
           is a type Brivity added that we have not mapped, which is not something
           to guess about when the guess lands on the call list. */
        const isNonLead = p.recordKind !== "lead";
        if (!match) {
            // Nothing to enrich, so a dead contact is simply not imported.
            if (isDead && !options.includeDead) {
                plan.skipped.dead++;
                continue;
            }
            // Same for a record that was never a lead in the first place.
            if (isNonLead && !options.includeNonLeads) {
                plan.skipped.nonLead++;
                continue;
            }
            plan.creates.push({
                brivityId: bid,
                brivityLeadId: p.brivityLeadId ?? null,
                brivityUuid: p.brivityUuid ?? null,
                brivityUrl: p.brivityUrl ?? null,
                name: displayName(p),
                phone: p.phone || null,
                email: p.email || null,
                intent: intentOf(p),
                status: statusOf(p),
                stage: p.crmStage || "new_lead",
                source: p.source || null,
                notes: p.crmNotes || null,
                address: p.address ?? null,
                tags: Array.isArray(p.tags) ? p.tags : [],
                marketReports: Number(p.reports || 0),
            });
            continue;
        }
        if (isDead && !options.enrichDeadMatches) {
            plan.skipped.dead++;
            continue;
        }
        // Merge: only record fields that would actually change.
        const changes = [];
        const bName = usableName(p.name);
        if (options.preferBrivityName && bName && bName !== (match.name || "")) {
            changes.push({ field: "name", from: match.name, to: bName });
        }
        /* Email FILLS A GAP; it does not overwrite. A lead carries one email field,
           so replacing a different address destroys the only copy — and Brivity
           returns no timestamps, so there is no basis for calling its address the
           fresher one. The CRM's value typically came from an actual conversation.
           (Phone already worked this way; email did not, which was inconsistent.) */
        if (p.email && !match.email) {
            changes.push({ field: "email", from: match.email, to: p.email });
        }
        if (p.phone && !match.phone) {
            changes.push({ field: "phone", from: match.phone, to: p.phone });
        }
        if (bid && String(match.brivityId || "") !== bid) {
            changes.push({ field: "brivityId", from: match.brivityId, to: bid });
        }
        /* Brivity is the system of record for buying vs selling — but only when it
           actually says. A null means "not stated", and overwriting a known intent
           with it would erase what this CRM already learned in conversation. */
        const bIntent = intentOf(p);
        if (bIntent && bIntent !== match.crmIntent) {
            changes.push({ field: "crmIntent", from: match.crmIntent, to: bIntent });
        }
        /*
         * Status only fills a gap, and never imports one that BURIES the lead. A
         * lead we have talked to in the DMs should not be filed away because a
         * Brivity row nobody has touched in a year says so — that would quietly
         * hide live conversations. Identity (name, email) is still enriched from
         * those rows.
         *
         * This guard used to read `!== "dead"` and that was sufficient only because
         * the old mapping collapsed archived and trash INTO dead. Now that they map
         * to their own statuses (which is correct), a Brivity "trash" row would
         * otherwise sail past a one-value check and bury 431 live leads. The guard
         * is a set, so splitting a status out of `dead` again cannot silently
         * reopen this.
         */
        const bStatus = statusOf(p);
        if (match.crmStatus === "new" && bStatus !== "new" && !BURYING_STATUSES.has(bStatus)) {
            changes.push({ field: "crmStatus", from: match.crmStatus, to: bStatus });
        }
        if (p.source && !match.source) {
            changes.push({ field: "source", from: match.source, to: p.source });
        }
        if (!changes.length) {
            plan.unchanged++;
            continue;
        }
        plan.merges.push({ leadId: match.id, brivityId: bid, matchedOn, changes });
    }
    plan.counts = {
        create: plan.creates.length,
        merge: plan.merges.length,
        renames: plan.merges.filter((m) => m.changes.some((c) => c.field === "name")).length,
    };
    return plan;
}
/**
 * Write a plan.
 *
 * Everything goes through `upsertLeadQuiet`, never `createLead` — see the note
 * at the top of this file. Filing existing contacts must not text Marco and
 * Carlos hundreds of times or email hundreds of cold contacts.
 */
async function applyBrivityImport(plan) {
    const { upsertLeadQuiet } = await Promise.resolve().then(() => __importStar(require("./db.js")));
    const leads = await (0, db_js_1.listAllLeads)();
    const byId = new Map(leads.map((l) => [l.id, l]));
    const out = {
        applied: true,
        created: 0,
        merged: 0,
        fieldsWritten: {},
        failures: [],
    };
    for (const c of plan.creates) {
        try {
            upsertLeadQuiet(leadFromPlannedCreate(c));
            out.created++;
        }
        catch (err) {
            out.failures.push({ ref: `create:${c.brivityId}`, error: err.message });
        }
    }
    for (const m of plan.merges) {
        const lead = byId.get(m.leadId);
        if (!lead) {
            out.failures.push({ ref: `merge:${m.leadId}`, error: "lead no longer exists" });
            continue;
        }
        try {
            const patch = {};
            for (const ch of m.changes) {
                patch[ch.field] = ch.to;
                out.fieldsWritten[ch.field] = (out.fieldsWritten[ch.field] || 0) + 1;
            }
            upsertLeadQuiet({ ...lead, ...patch });
            out.merged++;
        }
        catch (err) {
            out.failures.push({ ref: `merge:${m.leadId}`, error: err.message });
        }
    }
    return out;
}
/** The Lead a planned create becomes. Exported so apply and tests agree. */
function leadFromPlannedCreate(c) {
    return {
        platform: "brivity",
        userId: `brivity_${c.brivityId}`,
        username: null,
        name: c.name,
        phone: c.phone,
        email: c.email,
        state: state_js_1.FunnelStage.New,
        source: c.source,
        adCampaign: null,
        propertyInquired: null,
        criteria: null,
        brivityId: c.brivityId,
        crmStatus: c.status,
        /* Brivity's real stage. This was hard-coded to "new", which threw away the
           stage on 1,394 contacts at the write layer even when the read layer had
           it right. */
        crmStage: c.stage,
        crmPriority: "normal",
        /* The schema requires a value; "buyer" is the storage default for a contact
           whose intention Brivity never stated. It is NOT evidence they are a
           buyer, which is why the merge path refuses to write it over a known one. */
        crmIntent: c.intent ?? "buyer",
        crmCallQueue: "none",
        crmNotes: c.notes,
        address: c.address,
        tags: c.tags,
    };
}
