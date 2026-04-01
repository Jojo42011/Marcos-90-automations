"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Local mock server: GET / chat UI, POST /simulate → pipeline (CORS enabled on /simulate).
 */
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const webhook_js_1 = require("./app/webhook.js");
const db_js_1 = require("./core/db.js");
const index_js_1 = require("./integrations/sinch/index.js");
const app = (0, express_1.default)();
const PORT = Number(process.env.PORT) || 3000;
// Serve static HTML from project root ./public (run server via `npm run dev:mock` from repo root)
const publicDir = path_1.default.join(process.cwd(), "public");
app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
});
app.get("/", (_req, res) => {
    res.sendFile(path_1.default.join(publicDir, "chat.html"));
});
const simulateCors = (0, cors_1.default)({
    origin: true,
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
});
const resetCors = (0, cors_1.default)({
    origin: true,
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
});
async function handleSimulateBody(body, res) {
    try {
        const result = await (0, webhook_js_1.handleWebhook)(body);
        if (result.status === 400) {
            res.status(400).json({ error: "Invalid payload (need user_id, message, etc.)" });
            return;
        }
        res.status(200).json({ reply: result.reply ?? null });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
}
app.options("/simulate", simulateCors);
app.post("/simulate", express_1.default.json(), simulateCors, (req, res) => {
    void handleSimulateBody(req.body, res);
});
/** ManyChat External Request — same body/response as /simulate */
app.options("/webhook", simulateCors);
app.post("/webhook", express_1.default.json(), simulateCors, (req, res) => {
    void handleSimulateBody(req.body, res);
});
app.options("/reset", resetCors);
app.post("/reset", resetCors, (_req, res) => {
    (0, db_js_1.resetMemoryStore)();
    res.status(200).json({ ok: true, message: "In-memory store cleared." });
});
app.post("/sinch/inbound", express_1.default.json(), async (req, res) => {
    try {
        const payload = (0, index_js_1.receiveInbound)(req.body);
        if (!payload) {
            res.status(400).json({ error: "Invalid or unparseable Sinch inbound payload" });
            return;
        }
        const result = await (0, webhook_js_1.handleIncomingPayload)(payload);
        res.status(result.status).json({
            ok: result.status === 200,
            reply: result.reply ?? null,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[Sinch] /sinch/inbound error:", err);
        res.status(500).json({ error: message });
    }
});
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Listening on 0.0.0.0:${PORT}`);
    console.log(`Health:  GET  http://localhost:${PORT}/health`);
    console.log(`Mock UI: GET  http://localhost:${PORT}/`);
    console.log(`Simulate: POST http://localhost:${PORT}/simulate`);
    console.log(`Webhook: POST http://localhost:${PORT}/webhook`);
    console.log(`Reset:   POST http://localhost:${PORT}/reset`);
    console.log(`Sinch:   POST http://localhost:${PORT}/sinch/inbound`);
});
