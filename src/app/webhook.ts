/**
 * ManyChat (and future) webhook handler. Parse body, call pipeline, return 200.
 * In production mount this as POST /webhook or similar.
 */
import { run as runPipeline } from "./pipeline.js";
import type { IncomingWebhookPayload } from "../core/types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function calcHumanDelayMs(reply: string): number {
  // Defaults target a natural 3-5s feel while staying safely under common webhook timeout windows.
  const minMs = parsePositiveIntEnv("HUMAN_DELAY_MIN_MS", 1500);
  const maxMs = parsePositiveIntEnv("HUMAN_DELAY_MAX_MS", 7000);
  const baseMs = parsePositiveIntEnv("HUMAN_DELAY_BASE_MS", 1800);
  const perCharMs = parsePositiveIntEnv("HUMAN_DELAY_PER_CHAR_MS", 45);
  const jitterMs = parsePositiveIntEnv("HUMAN_DELAY_JITTER_MS", 800);

  const jitter = Math.floor(Math.random() * (jitterMs + 1));
  const raw = baseMs + reply.length * perCharMs + jitter;
  const boundedMax = Math.max(minMs, maxMs);
  return clamp(raw, minMs, boundedMax);
}

async function maybeApplyHumanDelay(reply: string | undefined, elapsedMs: number): Promise<void> {
  if (!reply) return;
  const enabled = process.env.HUMAN_DELAY_ENABLED !== "false";
  if (!enabled) return;

  // Keep total request time under a safe ceiling for webhook platforms.
  const maxTotalMs = parsePositiveIntEnv("HUMAN_DELAY_MAX_TOTAL_MS", 12000);
  const remaining = maxTotalMs - elapsedMs;
  if (remaining <= 0) return;

  const desiredDelay = calcHumanDelayMs(reply);
  const appliedDelay = Math.min(desiredDelay, remaining);
  if (appliedDelay > 0) {
    await sleep(appliedDelay);
  }
}

function parseBody(body: unknown): IncomingWebhookPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const platform = typeof b.platform === "string" ? b.platform : "instagram";
  const userId = typeof b.user_id === "string" ? b.user_id : String(b.user_id ?? "");
  const username = typeof b.username === "string" ? b.username : null;
  const message = typeof b.message === "string" ? b.message : "";
  const commentOrDm = b.comment_or_dm === "comment" ? "comment" : "dm";
  if (!userId) return null;
  return { platform, userId, username, message, commentOrDm };
}

export async function handleIncomingPayload(
  payload: IncomingWebhookPayload,
): Promise<{ status: number; reply?: string }> {
  const start = Date.now();
  const { reply } = await runPipeline(payload);
  const elapsed = Date.now() - start;
  await maybeApplyHumanDelay(reply ?? undefined, elapsed);
  return { status: 200, reply: reply ?? undefined };
}

export async function handleWebhook(body: unknown): Promise<{ status: number; reply?: string }> {
  try {
    console.log(
      "[webhook] incoming payload:",
      body === undefined ? "(undefined)" : JSON.stringify(body),
    );
  } catch {
    console.log("[webhook] incoming payload: (could not stringify)", body);
  }

  const payload = parseBody(body);
  if (!payload) {
    return { status: 400 };
  }
  return handleIncomingPayload(payload);
}

// Allow running as script for local test
if (process.argv[1]?.endsWith("webhook.ts")) {
  handleWebhook({
    platform: "instagram",
    user_id: "test-user",
    username: "testuser",
    message: "How much is this?",
    comment_or_dm: "dm",
  })
    .then((r) => console.log(r))
    .catch((e) => console.error(e));
}

