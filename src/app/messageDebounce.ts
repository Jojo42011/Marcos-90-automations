/**
 * Per-user inbound debounce: batch rapid-fire ad question taps into one pipeline turn.
 */
import type { IncomingWebhookPayload } from "../core/types.js";
import type { MarcoLogContext } from "./marcoLog.js";

const DEBOUNCE_MS = 4000;

type ProcessFn = (
  payload: IncomingWebhookPayload,
  log: MarcoLogContext,
) => Promise<{ status: number; reply?: string }>;

interface BatchWaiter {
  resolve: (result: { status: number; reply?: string }) => void;
  reject: (err: unknown) => void;
}

interface UserBatch {
  payloads: IncomingWebhookPayload[];
  timer: ReturnType<typeof setTimeout> | null;
  waiters: BatchWaiter[];
  log: MarcoLogContext;
}

const batches = new Map<string, UserBatch>();
const processing = new Set<string>();

function batchKey(payload: IncomingWebhookPayload): string {
  return `${payload.platform}::${payload.userId}`;
}

function combinePayloads(payloads: IncomingWebhookPayload[]): IncomingWebhookPayload {
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

async function flushBatch(key: string, process: ProcessFn): Promise<void> {
  const batch = batches.get(key);
  if (!batch) return;
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
      } else {
        w.resolve({ status: 200, reply: undefined });
      }
    }
  } catch (err) {
    for (const w of waiters) {
      w.reject(err);
    }
  } finally {
    processing.delete(key);
  }
}

/** Skip debounce for comment handshake (empty message) — respond immediately. */
export function shouldSkipMessageDebounce(payload: IncomingWebhookPayload): boolean {
  return !payload.message.trim();
}

/**
 * Queue inbound DM for debounced processing. Resolves when the batch flushes.
 * Only the last webhook in a burst receives the `reply`; earlier ones get no reply
 * so ManyChat does not send duplicate outbound DMs.
 */
export function scheduleDebouncedInbound(
  payload: IncomingWebhookPayload,
  log: MarcoLogContext,
  process: ProcessFn,
): Promise<{ status: number; reply?: string }> {
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
