"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncQuoMessages = syncQuoMessages;
exports.lastQuoSyncAt = lastQuoSyncAt;
exports.scheduleQuoSync = scheduleQuoSync;
/**
 * Pull Quo SMS into the local mirror.
 *
 * The shape of this sync is forced by the API: there is no "list my inbox"
 * call. `GET /v1/messages` demands both a phoneNumberId and the participants,
 * so the only route to a full picture is conversations-first, then messages
 * per conversation. With ~286 conversations on the account that is ~286
 * requests for a full pass, which is why:
 *
 *   - the default pass is INCREMENTAL: only conversations whose lastActivityAt
 *     moved since the previous run are re-read
 *   - a full pass is opt-in (`full: true`), used once on first connect
 *   - requests are issued with a small concurrency, not all at once
 *
 * Most of those conversations are CALLS. A call thread simply returns no
 * messages, and is skipped — it never becomes an empty "SMS thread" in the
 * CRM. That distinction is not visible on the conversation row, so it can only
 * be discovered by asking, which is the reason the sync looks expensive.
 */
const index_js_1 = require("../integrations/quo/index.js");
const quoStore_js_1 = require("./quoStore.js");
const META_LAST_SYNC = "last_sync_at";
const META_LAST_FULL = "last_full_sync_at";
const META_FULL_VERSION = "full_sync_version";
/**
 * Bump this whenever a fix changes what a full sweep would actually collect.
 * A mirror built by an older, wronger version re-sweeps itself once on the
 * next boot instead of sitting on incomplete history forever.
 *
 * v2 — the first production sweep stored 8 of 48 threads. Quo allows 10
 * requests/second and the client had no limiter and no retry, so most reads
 * came back 429 and were silently swallowed; worse, that partial pass was
 * recorded as a completed full sweep, and incremental runs only revisit
 * conversations that MOVED, so the missing 40 threads would never have come
 * back on their own.
 */
const FULL_SYNC_VERSION = "2";
/** Resolve the sending line: pinned by env, else the first on the account. */
async function resolvePhoneNumberId() {
    const pinned = (0, index_js_1.getQuoPhoneNumberId)();
    if (pinned)
        return pinned;
    try {
        const numbers = await (0, index_js_1.listPhoneNumbers)();
        return numbers[0]?.id ?? null;
    }
    catch {
        return null;
    }
}
/** Run `worker` over `items` with a modest concurrency cap. */
async function mapLimit(items, limit, worker) {
    const out = new Array(items.length);
    let next = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length)
                return;
            out[i] = await worker(items[i]);
        }
    });
    await Promise.all(runners);
    return out;
}
async function syncQuoMessages(opts = {}) {
    const startedAt = new Date().toISOString();
    const base = {
        ok: false, conversationsSeen: 0, conversationsWithMessages: 0, messagesStored: 0,
        newMessages: 0, skippedCallThreads: 0, threadsFailed: 0, full: opts.full === true,
        startedAt, finishedAt: startedAt,
    };
    if (!(0, index_js_1.isQuoConfigured)()) {
        return { ...base, error: "QUO_API_KEY is not set", finishedAt: new Date().toISOString() };
    }
    const phoneNumberId = await resolvePhoneNumberId();
    if (!phoneNumberId) {
        return { ...base, error: "No Quo phone number available on this account", finishedAt: new Date().toISOString() };
    }
    const lastSync = (0, quoStore_js_1.quoMetaGet)(META_LAST_SYNC);
    const everFull = (0, quoStore_js_1.quoMetaGet)(META_LAST_FULL);
    const sweptBy = (0, quoStore_js_1.quoMetaGet)(META_FULL_VERSION);
    /* First run is always full, whatever was asked for: an incremental first
       pass would mirror only whatever happened to move today and quietly
       present it as the whole history. A mirror swept by an older version is
       treated the same way — see FULL_SYNC_VERSION. */
    const staleSweep = everFull != null && sweptBy !== FULL_SYNC_VERSION;
    if (staleSweep) {
        console.log(`[Quo] mirror was built by sweep v${sweptBy ?? "1"}; re-sweeping at v${FULL_SYNC_VERSION}`);
    }
    const full = opts.full === true || !everFull || staleSweep;
    try {
        const conversations = await (0, index_js_1.listConversations)(full || !lastSync ? {} : { updatedAfter: lastSync });
        base.conversationsSeen = conversations.length;
        let stored = 0, fresh = 0, withMsgs = 0, calls = 0, failed = 0;
        /* Concurrency 2 against a 10 req/s quota. The client paces itself as well,
           but a thread can need several page requests, so the fan-out is kept
           small rather than relying on the limiter alone. */
        await mapLimit(conversations, 2, async (c) => {
            const participants = (c.participants || []).filter(Boolean);
            if (!participants.length)
                return;
            let msgs;
            try {
                msgs = await (0, index_js_1.listMessages)({
                    phoneNumberId: c.phoneNumberId || phoneNumberId,
                    participants,
                    maxResults: 100,
                    maxPages: full ? 5 : 2,
                });
            }
            catch (err) {
                /* One unreadable thread must not fail the whole pass — but it must not
                   vanish either. It is counted, and a pass with any failure is not
                   recorded as a completed full sweep, so the next run retries it
                   instead of assuming those conversations simply have no texts. */
                failed++;
                console.error(`[Quo] thread ${c.id} unreadable:`, err.message);
                return;
            }
            if (!msgs.length) {
                calls++;
                return;
            }
            withMsgs++;
            for (const m of msgs) {
                /* The counterparty is whichever end is not our own line. Quo puts the
                   other party in `to` on an outgoing message and in `from` on an
                   incoming one. */
                const peer = m.direction === "outgoing" ? (m.to || [])[0] : m.from;
                if (!peer)
                    continue;
                stored++;
                if ((0, quoStore_js_1.upsertQuoMessage)({
                    id: m.id,
                    conversationId: m.conversationId || c.id,
                    phoneNumberId: m.phoneNumberId || phoneNumberId,
                    peerKey: (0, index_js_1.phoneKey)(peer),
                    peer,
                    direction: m.direction === "outgoing" ? "outgoing" : "incoming",
                    text: m.text || "",
                    status: m.status || "",
                    createdAt: m.createdAt,
                    userId: m.userId || null,
                }))
                    fresh++;
            }
        });
        const finishedAt = new Date().toISOString();
        (0, quoStore_js_1.quoMetaSet)(META_LAST_SYNC, finishedAt);
        /* Only a clean sweep counts as "we have seen everything". Marking a
           partial pass full would strand every thread that was throttled: the
           incremental runs that follow only revisit conversations that MOVED, so
           a thread missed here would stay missing until someone texted again. */
        if (full && !failed) {
            (0, quoStore_js_1.quoMetaSet)(META_LAST_FULL, finishedAt);
            (0, quoStore_js_1.quoMetaSet)(META_FULL_VERSION, FULL_SYNC_VERSION);
        }
        return {
            ...base, ok: true, full,
            conversationsWithMessages: withMsgs, messagesStored: stored,
            newMessages: fresh, skippedCallThreads: calls, threadsFailed: failed, finishedAt,
        };
    }
    catch (err) {
        return {
            ...base,
            error: err instanceof Error ? err.message : String(err),
            finishedAt: new Date().toISOString(),
        };
    }
}
function lastQuoSyncAt() {
    return (0, quoStore_js_1.quoMetaGet)(META_LAST_SYNC);
}
/**
 * Poll on a timer. Quo supports webhooks and those are wired too, but a poll
 * is the safety net: a webhook missed while the app was restarting would
 * otherwise leave a message permanently absent from the CRM.
 */
function scheduleQuoSync(intervalMinutes = 5) {
    if (!(0, index_js_1.isQuoConfigured)()) {
        console.log("[Quo] not configured — SMS sync disabled");
        return;
    }
    const run = () => {
        syncQuoMessages()
            .then((r) => {
            if (!r.ok)
                console.error("[Quo] sync failed:", r.error);
            else {
                if (r.newMessages)
                    console.log(`[Quo] sync: ${r.newMessages} new message(s) across ${r.conversationsWithMessages} thread(s)`);
                if (r.threadsFailed)
                    console.error(`[Quo] sync: ${r.threadsFailed} thread(s) unreadable — will retry next pass`);
            }
        })
            .catch((e) => console.error("[Quo] sync threw:", e));
    };
    setTimeout(run, 15000); // let boot settle first
    setInterval(run, Math.max(1, intervalMinutes) * 60 * 1000);
    console.log(`[Quo] SMS sync scheduled every ${intervalMinutes}m`);
}
