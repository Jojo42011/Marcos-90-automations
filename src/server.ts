/**
 * HTTP server: GET / lead dashboard, POST /webhook & /simulate → pipeline (CORS on simulate/webhook).
 */
import "dotenv/config";
import http from "http";
import type { IncomingMessage } from "http";
import express from "express";
import cors from "cors";
import path from "path";
import {
  attachDeepgramSttProxy,
  isDeepgramSttConfigured,
  JARVIS_DEEPGRAM_LISTEN_PATH,
} from "./integrations/deepgram/deepgramSttProxy.js";
import {
  getTtsProvider,
  synthesizeSpeech,
} from "./integrations/voice/synthesize.js";
import { harveyVoiceLogEnabled, voiceLog } from "./integrations/voice/voiceLog.js";

import { handleWebhook, handleIncomingPayload } from "./app/webhook.js";
import {
  getDashboardSnapshot,
  resetMemoryStore,
  updateLeadCrmFields,
  getLeadById,
  appendMessage,
  findLeadByPhoneDigits,
  createLead,
} from "./core/db.js";
import { FunnelStage } from "./core/state.js";
import type { CrmIntent, CrmStage, CrmStatus } from "./core/types.js";
import type { IncomingWebhookPayload } from "./core/types.js";
import { receiveInbound } from "./integrations/sinch/index.js";
import {
  isSendblueConfigured,
  normalizeToUsE164,
  sendSendblueMessage,
  parseSendblueWebhookBody,
  shouldProcessSendblueInbound,
  getSendblueInboundFromNumber,
  getSendblueMessageHandle,
  claimSendblueInboundHandle,
  sendblueWebhookSecretMatches,
} from "./integrations/sendblue/index.js";
import { getAnthropicModel, isAnthropicApiKeyConfigured } from "./integrations/llm/index.js";
import { fetchAdsSummaryFromUpstream } from "./harvey/adsUpstream.js";
import { runHarveyChat, runHarveyOps, getHarveyModel } from "./harvey/index.js";
import { newMarcoRequestId, marcoCorrelationId } from "./app/marcoLog.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

/** Base URL of the Flask ad dashboard (no trailing slash), e.g. http://127.0.0.1:5050 or https://your-ad-app.fly.dev */
const AD_DASHBOARD_BASE_URL = process.env.AD_DASHBOARD_BASE_URL?.trim().replace(/\/$/, "") || "";
/** Optional Bearer token sent to the ad app if you add auth there later */
const AD_DASHBOARD_API_KEY = process.env.AD_DASHBOARD_API_KEY?.trim() || "";

// Serve static HTML from project root ./public (run server via `npm run dev:mock` from repo root)
const publicDir = path.join(process.cwd(), "public");

app.get("/health", (_req, res) => {
  const apiKeyConfigured = isAnthropicApiKeyConfigured();
  res.status(200).json({
    ok: true,
    anthropic: {
      api_key_configured: apiKeyConfigured,
      model: getAnthropicModel(),
      hint: apiKeyConfigured
        ? "Haiku runs for preflight, opening, and pipeline when those paths call the API (billing and valid JSON still required)."
        : "Set ANTHROPIC_API_KEY on the host. Without it, DMs use hardcoded fallbacks only.",
    },
    sendblue: {
      configured: isSendblueConfigured(),
      hint: isSendblueConfigured()
        ? "Outbound SMS/iMessage available; inbound receive webhook should point to POST /webhook/sendblue"
        : "Set SENDBLUE_API_KEY_ID, SENDBLUE_API_SECRET_KEY, SENDBLUE_FROM_NUMBER for SMS handoff from CRM.",
    },
    harvey: {
      model: getHarveyModel(),
      api_key_configured: isAnthropicApiKeyConfigured(),
      voice: {
        stt: isDeepgramSttConfigured() ? "deepgram" : "none",
        tts: getTtsProvider(),
        deepgram_listen: JARVIS_DEEPGRAM_LISTEN_PATH,
      },
    },
  });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "dashboard.html"));
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(publicDir, "dashboard.html"));
});

/** Legacy DM simulator */
app.get("/chat", (_req, res) => {
  res.sendFile(path.join(publicDir, "chat.html"));
});

app.get("/jarvis", (_req, res) => {
  res.sendFile(path.join(publicDir, "jarvis.html"));
});

app.get("/harvey-voice.js", (_req, res) => {
  res.sendFile(path.join(publicDir, "harvey-voice.js"));
});

function dashboardTokenOk(req: express.Request): boolean {
  return dashboardTokenOkIncoming(req);
}

function dashboardTokenOkIncoming(req: IncomingMessage | express.Request): boolean {
  const expected = process.env.DASHBOARD_TOKEN?.trim();
  if (!expected) return true;
  let q = "";
  if ("query" in req && req.query && typeof req.query.token === "string") {
    q = req.query.token;
  } else {
    try {
      const host = req.headers.host || "localhost";
      const url = new URL(req.url || "/", `http://${host}`);
      q = url.searchParams.get("token") || "";
    } catch {
      q = "";
    }
  }
  const auth = req.headers.authorization;
  const bearer =
    typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
      ? auth.slice(7).trim()
      : "";
  return q === expected || bearer === expected;
}

app.get("/api/dashboard/data", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  try {
    const data = await getDashboardSnapshot();
    res.status(200).json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.patch("/api/crm/lead/:id", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const id = String(req.params.id || "").trim();
  if (!id) {
    res.status(400).json({ error: "Missing lead id" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const crmStatus = typeof body.crmStatus === "string" ? body.crmStatus : undefined;
  const crmStage = typeof body.crmStage === "string" ? body.crmStage : undefined;
  const crmPriority = typeof body.crmPriority === "string" ? body.crmPriority : undefined;
  const crmIntent = typeof body.crmIntent === "string" ? body.crmIntent : undefined;
  const crmCallQueueRaw = typeof body.crmCallQueue === "string" ? body.crmCallQueue : undefined;
  const crmCallQueue =
    crmCallQueueRaw === "urgent" || crmCallQueueRaw === "routine" || crmCallQueueRaw === "none"
      ? crmCallQueueRaw
      : undefined;
  const crmNotes =
    body.crmNotes === null ? null : typeof body.crmNotes === "string" ? body.crmNotes : undefined;
  const name = body.name === null ? null : typeof body.name === "string" ? body.name : undefined;
  const email = body.email === null ? null : typeof body.email === "string" ? body.email : undefined;
  const phone = body.phone === null ? null : typeof body.phone === "string" ? body.phone : undefined;
  const source = body.source === null ? null : typeof body.source === "string" ? body.source : undefined;
  const propertyInquired =
    body.propertyInquired === null
      ? null
      : typeof body.propertyInquired === "string"
        ? body.propertyInquired
        : undefined;
  const brivityId =
    body.brivityId === null ? null : typeof body.brivityId === "string" ? body.brivityId : undefined;

  let criteria: Record<string, unknown> | null | undefined = undefined;
  if (body.criteria === null) criteria = null;
  else if (body.criteria && typeof body.criteria === "object") {
    const c = body.criteria as Record<string, unknown>;
    criteria = {};
    if ("priceCap" in c) {
      const n = c.priceCap;
      criteria.priceCap = n === null || n === "" ? null : typeof n === "number" ? n : Number(n);
    }
    if ("beds" in c) {
      const n = c.beds;
      criteria.beds = n === null || n === "" ? null : typeof n === "number" ? n : Number(n);
    }
    if ("baths" in c) {
      const n = c.baths;
      criteria.baths = n === null || n === "" ? null : typeof n === "number" ? n : Number(n);
    }
    if ("area" in c) {
      criteria.area = c.area === null ? null : typeof c.area === "string" ? c.area : String(c.area);
    }
  }

  try {
    const updated = await updateLeadCrmFields({
      leadId: id,
      crmStatus: crmStatus as any,
      crmStage: crmStage as any,
      crmPriority: crmPriority as any,
      crmIntent: crmIntent === "seller" || crmIntent === "buyer" ? crmIntent : undefined,
      crmCallQueue,
      crmNotes,
      name,
      email,
      phone,
      source,
      propertyInquired,
      brivityId,
      criteria: criteria as any,
    });
    if (!updated) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/** CRM: manually add a lead from the dashboard (not from ManyChat). */
app.post("/api/crm/lead", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
  const name = [firstName, lastName].filter(Boolean).join(" ") || null;
  const phoneRaw = typeof body.phone === "string" ? body.phone.trim() : "";
  const digits = phoneRaw.replace(/\D/g, "");
  const phone =
    digits.length === 10
      ? digits
      : digits.length === 11 && digits.startsWith("1")
        ? digits.slice(1)
        : null;
  if (!phone) {
    res.status(400).json({ error: "A valid US phone number is required" });
    return;
  }
  const existing = await findLeadByPhoneDigits(phone);
  if (existing) {
    res.status(409).json({ error: "A lead with this phone already exists", leadId: existing.id });
    return;
  }
  const email = typeof body.email === "string" && body.email.trim() ? body.email.trim() : null;
  const crmStatus = (
    ["not_contacted", "contacted", "nurture", "dead"].includes(String(body.crmStatus || ""))
      ? body.crmStatus
      : "not_contacted"
  ) as CrmStatus;
  const crmStage = (
    ["new", "hot", "warm", "cold", "appointment_set", "showing_set", "under_contract", "closed"].includes(
      String(body.crmStage || ""),
    )
      ? body.crmStage
      : "new"
  ) as CrmStage;
  const crmIntent = body.crmIntent === "seller" ? "seller" : "buyer";
  const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "Manual";
  const personType = typeof body.personType === "string" ? body.personType.trim() : "Lead";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const company = typeof body.company === "string" ? body.company.trim() : "";
  const street = typeof body.street === "string" ? body.street.trim() : "";
  const city = typeof body.city === "string" ? body.city.trim() : "";
  const stateAddr = typeof body.state === "string" ? body.state.trim() : "";
  const zip = typeof body.zip === "string" ? body.zip.trim() : "";
  const areaParts = [city, stateAddr, zip].filter(Boolean);
  const notesParts = [
    personType !== "Lead" ? `Person type: ${personType}` : "",
    description,
    company ? `Company: ${company}` : "",
    street ? `Address: ${[street, ...areaParts].filter(Boolean).join(", ")}` : areaParts.length ? `Area: ${areaParts.join(", ")}` : "",
  ].filter(Boolean);
  const userId = `manual-${phone}`;
  try {
    const lead = await createLead({
      platform: "manual",
      userId,
      username: null,
      name,
      phone,
      email,
      state: FunnelStage.New,
      source,
      propertyInquired: null,
      criteria: areaParts.length ? { priceCap: null, beds: null, baths: null, area: areaParts.join(", ") } : null,
      brivityId: null,
      crmStatus,
      crmStage,
      crmPriority: "normal",
      crmIntent: crmIntent as CrmIntent,
      crmCallQueue: "none",
      crmNotes: notesParts.length ? notesParts.join("\n") : null,
      adCampaign: null,
    });
    res.status(201).json({ ok: true, leadId: lead.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

function harveyDeps() {
  return {
    adDashboardBaseUrl: AD_DASHBOARD_BASE_URL,
    adDashboardApiKey: AD_DASHBOARD_API_KEY,
  };
}

app.get("/api/ads/summary", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  if (!AD_DASHBOARD_BASE_URL) {
    res.status(503).json({
      error: "Ads dashboard not linked",
      hint: "Set AD_DASHBOARD_BASE_URL to your Flask app base URL (e.g. http://127.0.0.1:5050)",
    });
    return;
  }
  try {
    const summary = await fetchAdsSummaryFromUpstream(
      AD_DASHBOARD_BASE_URL,
      AD_DASHBOARD_API_KEY,
    );
    res.status(200).json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ads/summary]", message);
    res.status(502).json({ error: message, hint: "Is the ad Flask app running and reachable?" });
  }
});

/** Harvey ops snapshot (perception + judgment, no LLM). */
app.get("/api/jarvis/ops", async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  try {
    const ops = await runHarveyOps(harveyDeps());
    res.status(200).json(ops);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[jarvis/ops]", message);
    res.status(500).json({ error: message });
  }
});

app.post("/api/jarvis/chat", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "Missing message" });
    return;
  }
  const sessionId =
    typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : undefined;

  try {
    voiceLog("chat request", { chars: message.length, hasSession: Boolean(sessionId) });
    const t0 = Date.now();
    const result = await runHarveyChat({
      message,
      sessionId,
      deps: harveyDeps(),
    });
    voiceLog("chat ok", {
      ms: Date.now() - t0,
      intent: result.intent,
      speechChars: (result.speech || "").length,
    });
    res.status(200).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    voiceLog("chat failed", { error: msg });
    console.error("[jarvis/chat]", msg);
    res.status(500).json({ error: msg });
  }
});

/** Deepgram STT — browser connects to same-origin WSS (see deepgramSttProxy). */
app.get("/api/jarvis/deepgram/token", (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  if (!isDeepgramSttConfigured()) {
    voiceLog("STT token denied: not configured");
    res.status(503).json({
      error: "Deepgram STT not configured",
      hint: "Set DEEPGRAM_API_KEY in .env",
    });
    return;
  }
  voiceLog("STT token issued", { path: JARVIS_DEEPGRAM_LISTEN_PATH });
  res.status(200).json({ mode: "proxy", url: JARVIS_DEEPGRAM_LISTEN_PATH });
});

/** Harvey TTS — MP3 (ElevenLabs if configured, else Deepgram Aura). */
app.post("/api/jarvis/voice", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN in .env or pass ?token=" });
    return;
  }
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text.trim()) {
    res.status(400).json({ error: "Missing text" });
    return;
  }
  const t0 = Date.now();
  voiceLog("TTS request", { provider: getTtsProvider(), chars: text.trim().length });
  try {
    const audio = await synthesizeSpeech(text);
    voiceLog("TTS ok", { provider: getTtsProvider(), bytes: audio.length, ms: Date.now() - t0 });
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(audio);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    voiceLog("TTS failed", { error: message, ms: Date.now() - t0 });
    console.error("[jarvis/voice]", message);
    res.status(502).json({ error: message });
  }
});

const simulateCors = cors({
  origin: true,
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
});

const resetCors = cors({
  origin: true,
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
});

async function handleSimulateBody(body: unknown, res: express.Response): Promise<void> {
  try {
    const result = await handleWebhook(body);
    if (result.status === 400) {
      res.status(400).json({ error: "Invalid payload (need user_id, message, etc.)" });
      return;
    }
    res.status(200).json({ reply: result.reply ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
}

app.options("/simulate", simulateCors);
app.post("/simulate", express.json(), simulateCors, (req, res) => {
  void handleSimulateBody(req.body, res);
});

/** ManyChat External Request — same body/response as /simulate */
app.options("/webhook", simulateCors);
app.post("/webhook", express.json(), simulateCors, (req, res) => {
  void handleSimulateBody(req.body, res);
});


app.options("/reset", resetCors);
app.post("/reset", resetCors, (_req, res) => {
  resetMemoryStore();
  res.status(200).json({ ok: true, message: "In-memory store cleared." });
});

app.post("/sinch/inbound", express.json(), async (req, res) => {
  try {
    const payload = receiveInbound(req.body);
    if (!payload) {
      res.status(400).json({ error: "Invalid or unparseable Sinch inbound payload" });
      return;
    }
    const result = await handleIncomingPayload(payload);
    res.status(result.status).json({
      ok: result.status === 200,
      reply: result.reply ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Sinch] /sinch/inbound error:", err);
    res.status(500).json({ error: message });
  }
});

/** Sendblue inbound (receive) — configure in Sendblue dashboard → Webhooks → Inbound Messages. */
app.post("/webhook/sendblue", express.json(), async (req, res) => {
  try {
    const presented = req.get("sb-signing-secret") ?? undefined;
    if (!sendblueWebhookSecretMatches(presented)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const body = parseSendblueWebhookBody(req.body);
    if (!body) {
      res.status(200).json({ ok: false });
      return;
    }
    if (!shouldProcessSendblueInbound(body)) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }
    const handle = getSendblueMessageHandle(body);
    if (!claimSendblueInboundHandle(handle)) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    const from = getSendblueInboundFromNumber(body);
    if (!from) {
      res.status(200).json({ ok: true, reason: "no_from" });
      return;
    }
    const lead = await findLeadByPhoneDigits(from);
    if (!lead) {
      console.warn("[sendblue] inbound from unknown phone:", from);
      res.status(200).json({ ok: true, unknown_lead: true });
      return;
    }
    const message = typeof body.content === "string" ? body.content.trim() : "";
    const payload: IncomingWebhookPayload = {
      platform: lead.platform,
      userId: lead.userId,
      username: lead.username,
      displayName: lead.name,
      message,
      commentOrDm: "dm",
      marcoPreviousOutbound: null,
    };
    const requestId = newMarcoRequestId();
    const correlationId = marcoCorrelationId(payload.platform, payload.userId);
    const result = await handleIncomingPayload(payload, { requestId, correlationId });

    if (result.reply?.trim() && isSendblueConfigured()) {
      const send = await sendSendblueMessage({ to: lead.phone!, content: result.reply.trim() });
      if (!send.ok) {
        console.error("[sendblue] outbound after pipeline failed:", send.error);
      }
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sendblue] /webhook/sendblue error:", err);
    res.status(500).json({ error: message });
  }
});

/** CRM / VA: outbound text via Sendblue — pick a saved lead or send to a custom number. */
app.post("/api/sendblue/send", express.json(), async (req, res) => {
  if (!dashboardTokenOk(req)) {
    res.status(401).json({ error: "Unauthorized", hint: "Set DASHBOARD_TOKEN or pass ?token=" });
    return;
  }
  if (!isSendblueConfigured()) {
    res.status(503).json({
      error: "Sendblue not configured",
      hint: "Set SENDBLUE_API_KEY_ID, SENDBLUE_API_SECRET_KEY, SENDBLUE_FROM_NUMBER on the server",
    });
    return;
  }
  const leadId = typeof req.body?.leadId === "string" ? req.body.leadId.trim() : "";
  const toRaw = typeof req.body?.to === "string" ? req.body.to.trim() : "";
  const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
  if (!content) {
    res.status(400).json({ error: "Missing content" });
    return;
  }
  if (!leadId && !toRaw) {
    res.status(400).json({ error: "Provide leadId or to (phone number)" });
    return;
  }
  try {
    let to = "";
    let threadLeadId: string | null = null;

    if (leadId) {
      const lead = await getLeadById(leadId);
      if (!lead) {
        res.status(404).json({ error: "Lead not found" });
        return;
      }
      if (!lead.phone?.trim()) {
        res.status(400).json({ error: "Lead has no phone number" });
        return;
      }
      to = normalizeToUsE164(lead.phone);
      threadLeadId = lead.id;
    } else {
      to = normalizeToUsE164(toRaw);
      const digits = to.replace(/\D/g, "");
      if (digits.length < 10) {
        res.status(400).json({ error: "Invalid phone number" });
        return;
      }
      const matched = await findLeadByPhoneDigits(to);
      if (matched) threadLeadId = matched.id;
    }

    const send = await sendSendblueMessage({ to, content });
    if (!send.ok) {
      res.status(502).json({ error: send.error });
      return;
    }
    if (threadLeadId) {
      await appendMessage(threadLeadId, "assistant", content);
    }
    res.status(200).json({ ok: true, threadAttached: Boolean(threadLeadId) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

const httpServer = http.createServer(app);
attachDeepgramSttProxy(httpServer, {
  path: JARVIS_DEEPGRAM_LISTEN_PATH,
  isAuthorized: dashboardTokenOkIncoming,
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on 0.0.0.0:${PORT}`);
  if (harveyVoiceLogEnabled()) {
    console.log("[HarveyVoice] Server voice logging ON — set HARVEY_VOICE_LOG=1 (or MARCO_LOG_LEVEL=debug)");
  }
  if (isAnthropicApiKeyConfigured()) {
    console.log(`[Anthropic] API key present — model ${getAnthropicModel()} (set ANTHROPIC_MODEL to override).`);
  } else {
    console.warn(
      "[Anthropic] ANTHROPIC_API_KEY missing — preflight/opening/pipeline skip Haiku and use template fallbacks only.",
    );
  }
  console.log(`Health:  GET  http://localhost:${PORT}/health`);
  console.log(`Dashboard: GET http://localhost:${PORT}/ (also /dashboard)`);
  console.log(`Chat demo: GET http://localhost:${PORT}/chat`);
  console.log(`Harvey:  GET  http://localhost:${PORT}/jarvis`);
  console.log(`Harvey ops: GET http://localhost:${PORT}/api/jarvis/ops`);
  console.log(`Harvey chat: POST http://localhost:${PORT}/api/jarvis/chat (model ${getHarveyModel()})`);
  if (isDeepgramSttConfigured()) {
    console.log(`Harvey STT: WSS  ws://localhost:${PORT}${JARVIS_DEEPGRAM_LISTEN_PATH} (proxy)`);
  }
  console.log(`Harvey TTS: POST http://localhost:${PORT}/api/jarvis/voice (${getTtsProvider()})`);
  console.log(`Simulate: POST http://localhost:${PORT}/simulate`);
  console.log(`Webhook: POST http://localhost:${PORT}/webhook`);
  console.log(`Reset:   POST http://localhost:${PORT}/reset`);
  console.log(`Sinch:   POST http://localhost:${PORT}/sinch/inbound`);
  console.log(`Sendblue receive: POST http://localhost:${PORT}/webhook/sendblue`);
  console.log(`Sendblue CRM send: POST http://localhost:${PORT}/api/sendblue/send (auth: DASHBOARD_TOKEN)`);
  console.log(`Ads proxy: GET http://localhost:${PORT}/api/ads/summary (needs AD_DASHBOARD_BASE_URL)`);
  if (AD_DASHBOARD_BASE_URL) {
    console.log(`  → upstream: ${AD_DASHBOARD_BASE_URL}/api/latest`);
  }
});

