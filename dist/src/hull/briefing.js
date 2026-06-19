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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOhioDateString = getOhioDateString;
exports.getTimeAwareGreeting = getTimeAwareGreeting;
exports.handleActivation = handleActivation;
exports.generateBrief = generateBrief;
exports.scheduleMorningBriefing = scheduleMorningBriefing;
const store_js_1 = require("./memory/store.js");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const modelRouting_js_1 = require("./modelRouting.js");
const LAST_BRIEFED_DATE_KEY = "last_briefed_date";
function getOhioDateString() {
    return new Date().toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
}
function getTimeAwareGreeting() {
    const hour = parseInt(new Date().toLocaleString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        hour12: false,
    }), 10);
    if (hour < 12)
        return "Good morning sir.";
    if (hour < 17)
        return "Good afternoon sir.";
    return "Good evening sir.";
}
async function handleActivation(memoryPacket) {
    const today = getOhioDateString();
    const lastBriefed = (0, store_js_1.getSystemState)(LAST_BRIEFED_DATE_KEY);
    if (today !== lastBriefed) {
        const brief = await generateBrief(memoryPacket);
        (0, store_js_1.setSystemState)(LAST_BRIEFED_DATE_KEY, today);
        return brief;
    }
    return `${getTimeAwareGreeting()} What do you need?`;
}
async function generateBrief(memoryPacket) {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (!key)
        return getTimeAwareGreeting() + " Systems are online.";
    const client = new sdk_1.default({ apiKey: key });
    try {
        const res = await client.messages.create({
            model: (0, modelRouting_js_1.getHaikuModel)(),
            max_tokens: 300,
            messages: [
                {
                    role: "user",
                    content: `Generate a morning brief for Marco Puga (real estate agent). Max 4 sentences, spoken aloud. Most urgent first. Max 3 items. Open with time-aware greeting. If nothing new: "All clear sir. What do you need?" Context:\n${memoryPacket.slice(0, 2000)}`,
                },
            ],
        });
        const text = res.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();
        return text || getTimeAwareGreeting();
    }
    catch {
        return getTimeAwareGreeting();
    }
}
function scheduleMorningBriefing(onBrief) {
    const scheduleNext = () => {
        const now = new Date();
        const target = new Date(now);
        target.setHours(7, 0, 0, 0);
        if (target <= now)
            target.setDate(target.getDate() + 1);
        const delay = target.getTime() - now.getTime();
        setTimeout(async () => {
            const { searchFacts, getMemoryPacket } = await Promise.resolve().then(() => __importStar(require("./memory/retrieval.js")));
            const facts = await searchFacts("morning business priorities", 8);
            const packet = getMemoryPacket("morning brief", facts);
            const brief = await generateBrief(packet);
            onBrief(brief);
            scheduleNext();
        }, delay);
    };
    scheduleNext();
}
