"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWeeklySynthesis = runWeeklySynthesis;
exports.scheduleWeeklySynthesis = scheduleWeeklySynthesis;
const crypto_1 = require("crypto");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const store_js_1 = require("./store.js");
const ws_js_1 = require("../ws.js");
const HAIKU = "claude-haiku-4-5-20251001";
function msUntilNextSunday3am() {
    const now = new Date();
    const target = new Date(now);
    const day = now.getDay();
    const daysUntilSunday = day === 0 ? 0 : 7 - day;
    target.setDate(now.getDate() + daysUntilSunday);
    target.setHours(3, 0, 0, 0);
    if (target <= now)
        target.setDate(target.getDate() + 7);
    return target.getTime() - now.getTime();
}
async function runWeeklySynthesis() {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (!key)
        return;
    const db = (0, store_js_1.getHullDb)();
    const episodes = db
        .prepare("SELECT summary, tone FROM episodes WHERE timestamp >= datetime('now', '-7 days')")
        .all();
    const facts = db
        .prepare("SELECT content, strength FROM facts WHERE superseded_by IS NULL ORDER BY access_count DESC LIMIT 20")
        .all();
    const rules = db
        .prepare("SELECT trigger_condition, action, confidence FROM rules WHERE confidence >= 0.6")
        .all();
    const client = new sdk_1.default({ apiKey: key });
    const prompt = `Write a weekly pattern synthesis for Marco Puga's real estate business. Episodes: ${JSON.stringify(episodes).slice(0, 4000)}. Top facts: ${JSON.stringify(facts).slice(0, 3000)}. Rules: ${JSON.stringify(rules).slice(0, 2000)}. 3-5 paragraphs: patterns, risks, recommendations.`;
    try {
        const res = await client.messages.create({
            model: HAIKU,
            max_tokens: 1200,
            messages: [{ role: "user", content: prompt }],
        });
        const text = res.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();
        if (!text)
            return;
        const now = new Date().toISOString();
        db.prepare("INSERT INTO syntheses (id, content, week_start, created_at) VALUES (?, ?, datetime('now', '-7 days'), ?)").run((0, crypto_1.randomUUID)(), text, now);
        (0, ws_js_1.broadcastHullEvent)({ type: "memory_updated" });
        console.log("[hull/synthesis] weekly synthesis stored");
    }
    catch (err) {
        console.error("[hull/synthesis]", err instanceof Error ? err.message : err);
    }
}
function scheduleWeeklySynthesis() {
    const schedule = () => {
        const delay = msUntilNextSunday3am();
        setTimeout(async () => {
            await runWeeklySynthesis();
            schedule();
        }, delay);
    };
    schedule();
    console.log("[hull/synthesis] weekly synthesis scheduled");
}
