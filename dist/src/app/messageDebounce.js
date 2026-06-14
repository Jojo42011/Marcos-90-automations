"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldSkipMessageDebounce = shouldSkipMessageDebounce;
exports.scheduleDebouncedInbound = scheduleDebouncedInbound;
const DEBOUNCE_MS = 4000;
const batches = new Map();
const processing = new Set();
function batchKey(payload) {
    return `${payload.platform}::${payload.userId}`;
}
function combinePayloads(payloads) {
    const last = payloads[payloads.length - 1];
    const combinedMessage = payloads
        .map((p) => p.message.trim())
        .filter(Boolean)
        .join("\n");
    const seedOpener = payloads.find((p) => p.marcoPreviousOutbound?.trim())?.marcoPreviousOutbound ?? null;
    return {
        ...last,
        message: combinedMessage,
        marcoPreviousOutbound: seedOpener ?? last.marcoPreviousOutbound,
    };
}
async function flushBatch(key, process) {
    const batch = batches.get(key);
    if (!batch)
        return;
    batches.delete(key);
    if (batch.timer) {
        clearTimeout(batch.timer);
        batch.timer = null;
    }
    const count = batch.payloads.length;
    const userId = batch.payloads[0]?.userId ?? key;
    if (count > 1) {
        console.log(`Batching ${count} messages from user ${userId}`);
    }
    const combined = combinePayloads(batch.payloads);
    const waiters = batch.waiters;
    const lastWaiter = waiters[waiters.length - 1];
    if (processing.has(key)) {
        for (const w of waiters) {
            w.resolve({ status: 200, reply: undefined });
        }
        return;
    }
    processing.add(key);
    try {
        const result = await process(combined, batch.log);
        for (let i = 0; i < waiters.length; i++) {
            const w = waiters[i];
            if (w === lastWaiter) {
                w.resolve(result);
            }
            else {
                w.resolve({ status: 200, reply: undefined });
            }
        }
    }
    catch (err) {
        for (const w of waiters) {
            w.reject(err);
        }
    }
    finally {
        processing.delete(key);
    }
}
/** Skip debounce for comment handshake (empty message) — respond immediately. */
function shouldSkipMessageDebounce(payload) {
    return !payload.message.trim();
}
/**
 * Queue inbound DM for debounced processing. Resolves when the batch flushes.
 * Only the last webhook in a burst receives the `reply`; earlier ones get no reply
 * so ManyChat does not send duplicate outbound DMs.
 */
function scheduleDebouncedInbound(payload, log, process) {
    return new Promise((resolve, reject) => {
        const key = batchKey(payload);
        let batch = batches.get(key);
        if (!batch) {
            batch = {
                payloads: [],
                timer: null,
                waiters: [],
                log,
            };
            batches.set(key, batch);
        }
        batch.payloads.push(payload);
        batch.waiters.push({ resolve, reject });
        batch.log = log;
        if (batch.timer) {
            clearTimeout(batch.timer);
        }
        batch.timer = setTimeout(() => {
            void flushBatch(key, process);
        }, DEBOUNCE_MS);
    });
}
