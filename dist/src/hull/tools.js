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
exports.getHullToolDefinitions = getHullToolDefinitions;
exports.executeHullTool = executeHullTool;
exports.buildMemoryPacketForQuery = buildMemoryPacketForQuery;
const tools_js_1 = require("../harvey/tools.js");
const platformTools_js_1 = require("../harvey/platformTools.js");
const codeExec_js_1 = require("../core/codeExec.js");
const webResearch_js_1 = require("../core/webResearch.js");
const retrieval_js_1 = require("./memory/retrieval.js");
const store_js_1 = require("./memory/store.js");
const crypto_1 = require("crypto");
const embeddings_js_1 = require("./memory/embeddings.js");
const nodes_js_1 = require("./memory/nodes.js");
const whatsappSend_js_1 = require("./whatsappSend.js");
const index_js_1 = require("../integrations/gmail/index.js");
const index_js_2 = require("../integrations/openshorts/index.js");
const WHATSAPP_SEND_TOOL = {
    name: "whatsapp_send",
    description: "Send a WhatsApp message from Marco's linked line (+19804430453). Only when Marco explicitly asks to text/send someone. Allowed contacts: jahan (+17373461943).",
    input_schema: {
        type: "object",
        properties: {
            to: { type: "string", description: "Contact name (jahan) or E.164 phone" },
            message: { type: "string", description: "Message body to send" },
        },
        required: ["to", "message"],
    },
};
const MEMORY_TOOLS = [
    {
        name: "memory_store",
        description: "Explicitly store a durable fact about Marco or his business. Only call when Marco says remember, store, or learn — or shares a stable business fact worth keeping.",
        input_schema: {
            type: "object",
            properties: {
                content: { type: "string" },
                category: { type: "string" },
                keywords: { type: "string" },
            },
            required: ["content"],
        },
    },
    {
        name: "memory_recall",
        description: "Semantic search across facts and episodes. Only call when Marco asks to recall, remember, or search memory — not for live lead data.",
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string" },
            },
            required: ["query"],
        },
    },
    {
        name: "memory_graph",
        description: "Traverse knowledge graph for an entity name. Only call when Marco asks about relationships, connections, or the graph around a person/project.",
        input_schema: {
            type: "object",
            properties: {
                entity: { type: "string" },
            },
            required: ["entity"],
        },
    },
];
const GMAIL_SEND_TOOL = {
    name: "gmail_send",
    description: "Send an email from Marco's Gmail account. Only when Marco explicitly asks to email or send something to a lead or contact. Requires recipient address, subject, and body.",
    input_schema: {
        type: "object",
        properties: {
            to: { type: "string", description: "Recipient email address" },
            subject: { type: "string", description: "Email subject line" },
            body: { type: "string", description: "Email body (plain text or HTML)" },
            html: { type: "boolean", description: "Set true when body contains HTML" },
        },
        required: ["to", "subject", "body"],
    },
};
const WEB_SEARCH_TOOL = {
    name: "web_search",
    description: "Search the internet and get back result titles, URLs and snippets. Use for news, prices, competitors, market data, or anything outside Marco's own systems. Do NOT call for questions answerable from memory or the business tools. " +
        "SNIPPETS ARE NOT SOURCES: a snippet is a teaser, often stale and sometimes wrong. When the answer matters, follow up with read_web_page on the results you intend to rely on, and say which pages you actually read. " +
        "If this returns ok:false it FAILED — say the search failed. Never report a failed search as 'I found nothing'.",
    input_schema: {
        type: "object",
        properties: {
            query: { type: "string", description: "What to search for." },
            limit: { type: "number", description: "How many results, 1-10. Default 6." },
        },
        required: ["query"],
    },
};
const READ_PAGE_TOOL = {
    name: "read_web_page",
    description: "Open a URL in Marco's paired browser and read the page's actual text. This is how you READ A SOURCE rather than guessing from a search snippet — always do this before quoting a figure, a price, or a claim you will act on. " +
        "Because it is Marco's own signed-in browser, it can also read pages behind a login that no search engine can see. " +
        "If the result says needsLogin, you got the sign-in page and NOT the source: say so instead of summarising what you were shown.",
    input_schema: {
        type: "object",
        properties: {
            url: { type: "string", description: "Full URL starting with http:// or https://" },
            selector: { type: "string", description: "Optional CSS selector to read just one region (e.g. 'article')." },
            device: { type: "string", description: "Which paired browser, by name. Omit for the priority browser." },
        },
        required: ["url"],
    },
};
const ANALYZE_REEL_TOOL = {
    name: "analyze_reel",
    description: "Follow an Instagram, TikTok, or YouTube-Short/Reel link that Marco pasted into chat, watch the actual video, and return a short-form-strategist breakdown (what it is, the hook, structure/pacing, why it works, and takeaways Marco can steal for his real-estate content). ALWAYS call this whenever Marco's message contains a reel/short/video URL — do not guess at the content from the URL alone. Downloads + transcribes + reads keyframes server-side; may take up to a minute.",
    input_schema: {
        type: "object",
        properties: {
            url: { type: "string", description: "The full https reel/short/video URL to analyze" },
            note: {
                type: "string",
                description: "Optional: what Marco said alongside the link (e.g. 'is this a good hook?') so the analysis can focus on it",
            },
        },
        required: ["url"],
    },
};
function getHullToolDefinitions(opts) {
    const tools = [...tools_js_1.HARVEY_TOOL_DEFINITIONS, ...MEMORY_TOOLS, ANALYZE_REEL_TOOL];
    if (opts?.whatsappSend)
        tools.push(WHATSAPP_SEND_TOOL);
    if ((0, index_js_1.isGmailConfigured)())
        tools.push(GMAIL_SEND_TOOL);
    /* Search is offered when EITHER backend exists: the Brave API (works
       unattended) or the paired browser (needs Marco's Chrome open, but reads
       real pages and can see behind a login). Reading a page is browser-only —
       no search API returns a page body. */
    if (process.env.BRAVE_SEARCH_API_KEY?.trim() || (0, webResearch_js_1.webResearchAvailable)())
        tools.push(WEB_SEARCH_TOOL);
    if ((0, webResearch_js_1.webResearchAvailable)())
        tools.push(READ_PAGE_TOOL);
    /* Only offered when execution is actually switched on. Harvey never sees a
       tool he would have to refuse. */
    if ((0, codeExec_js_1.execMode)() === "local")
        tools.push(...platformTools_js_1.EXEC_TOOL_DEFINITIONS);
    return tools;
}
async function executeHullTool(name, input) {
    if (name === "memory_store") {
        const content = String(input.content || "").trim();
        if (!content)
            return { error: "content required" };
        const db = (0, store_js_1.getHullDb)();
        const id = (0, crypto_1.randomUUID)();
        const now = new Date().toISOString();
        const vec = await (0, embeddings_js_1.embedText)(content);
        db.prepare(`INSERT INTO facts (id, content, category, keywords, strength, access_count, last_accessed, created_at, embedding)
       VALUES (?, ?, ?, ?, 1.0, 0, ?, ?, ?)`).run(id, content, String(input.category || "general"), String(input.keywords || ""), now, now, vec ? (0, embeddings_js_1.float32ToBlob)(vec) : null);
        return { ok: true, id };
    }
    if (name === "memory_recall") {
        const query = String(input.query || "").trim();
        const facts = await (0, retrieval_js_1.searchFacts)(query, 10);
        const db = (0, store_js_1.getHullDb)();
        const episodes = db
            .prepare("SELECT summary, tone, timestamp FROM episodes ORDER BY timestamp DESC LIMIT 5")
            .all();
        return { facts, episodes };
    }
    if (name === "memory_graph") {
        const entity = String(input.entity || "").trim();
        const node = (0, nodes_js_1.findSimilarNode)(entity);
        if (!node)
            return { error: "entity not found", entity };
        const db = (0, store_js_1.getHullDb)();
        const edges = db
            .prepare(`SELECT e.relationship, n.name as name, n.type
         FROM edges e JOIN nodes n ON e.target_id = n.id WHERE e.source_id = ?
         UNION
         SELECT e.relationship, n.name, n.type
         FROM edges e JOIN nodes n ON e.source_id = n.id WHERE e.target_id = ?`)
            .all(node.id, node.id);
        return { entity: node.name, connections: edges };
    }
    if (name === "web_search") {
        const query = String(input.query || "").trim();
        const limit = Math.min(Math.max(Number(input.limit) || 6, 1), 10);
        const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
        /* Prefer the API when a key exists: it is faster and does not need anyone's
           browser to be open. Fall back to driving the paired browser. */
        if (apiKey) {
            const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
            const res = await fetch(url, { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } });
            if (!res.ok)
                return { ok: false, error: `Brave search failed: ${res.status}`, say: "Say the search failed — do not report it as nothing found." };
            const data = (await res.json());
            return {
                ok: true,
                engine: "brave",
                results: (data.web?.results || []).slice(0, limit),
                note: "Snippets only. Call read_web_page on a result before relying on it.",
            };
        }
        const { searchWeb } = await Promise.resolve().then(() => __importStar(require("../core/webResearch.js")));
        const out = await searchWeb(query, { limit, device: String(input.device || "") || undefined });
        return {
            ...out,
            say: out.ok
                ? "These are snippets. Read the sources you intend to rely on before quoting them."
                : "The search FAILED. Say so plainly — do not report it as 'nothing found'.",
        };
    }
    if (name === "read_web_page") {
        const { readWebPage } = await Promise.resolve().then(() => __importStar(require("../core/webResearch.js")));
        const out = await readWebPage(String(input.url || ""), {
            device: String(input.device || "") || undefined,
            selector: String(input.selector || "") || undefined,
        });
        return {
            ...out,
            say: out.ok
                ? (out.needsLogin
                    ? "You received a LOGIN PAGE, not the source. Say that; do not summarise it as the article."
                    : "Cite this page by name when you use it.")
                : "The page could not be read. Say so rather than describing what it probably said.",
        };
    }
    if (name === "analyze_reel") {
        const url = String(input.url || "").trim();
        const note = String(input.note || "").trim();
        if (!/^https?:\/\//i.test(url)) {
            return { error: "Provide the full reel/short URL (starting with http)." };
        }
        console.log(`[reel] tool analyze_reel url=${url.slice(0, 80)}`);
        try {
            const result = await (0, index_js_2.analyzeReelViaOpenShorts)(url, note);
            if (result.status === "failed") {
                return { error: result.error || "Reel analysis failed." };
            }
            const meta = result.metadata || {};
            return {
                ok: true,
                analysis: result.analysis,
                transcript: result.transcript,
                platform: meta.platform,
                title: meta.title,
                uploader: meta.uploader,
                views: meta.view_count,
                likes: meta.like_count,
                duration: meta.duration,
                source_url: meta.webpage_url || url,
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[reel] tool failed: ${message}`);
            return { error: `Reel analysis failed: ${message}` };
        }
    }
    if (name === "whatsapp_send") {
        const to = String(input.to || "").trim();
        const message = String(input.message || "").trim();
        if (!to || !message)
            return { error: "to and message required" };
        if (!(0, whatsappSend_js_1.resolveWhatsAppTarget)(to)) {
            return { error: `Not allowed to message ${to}. Allowed: jahan (+17373461943)` };
        }
        return (0, whatsappSend_js_1.sendWhatsAppViaGateway)(to, message);
    }
    if (name === "gmail_send") {
        if (!(0, index_js_1.isGmailConfigured)()) {
            return { error: "Gmail not configured — set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN" };
        }
        const toRaw = String(input.to || "").trim();
        const subject = String(input.subject || "").trim();
        const body = String(input.body || "").trim();
        if (!toRaw || !subject || !body)
            return { error: "to, subject, and body required" };
        console.log(`[gmail] tool gmail_send to=${toRaw} subject="${subject.slice(0, 60)}"`);
        try {
            const result = await (0, index_js_1.sendEmail)({ to: toRaw, subject, body, html: input.html === true });
            console.log(`[gmail] tool ok id=${result.messageId} from=${result.from} to=${result.to}`);
            return result;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[gmail] tool failed: ${message}`);
            return { error: message };
        }
    }
    return (0, tools_js_1.executeHarveyTool)(name, input);
}
async function buildMemoryPacketForQuery(query) {
    const facts = await (0, retrieval_js_1.searchFacts)(query, 8);
    return (0, retrieval_js_1.getMemoryPacket)(query, facts);
}
