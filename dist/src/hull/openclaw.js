"use strict";
/**
 * OpenClaw gateway integration — OpenAI-compatible /v1/chat/completions
 * OpenClaw is the pipe; Harvey hull is the brain.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOpenClawSession = getOpenClawSession;
exports.resetOpenClawSession = resetOpenClawSession;
exports.openAiCompletionResponse = openAiCompletionResponse;
exports.handleOpenClawChatCompletions = handleOpenClawChatCompletions;
const agentLoop_js_1 = require("./agentLoop.js");
const extraction_js_1 = require("./memory/extraction.js");
const whatsappSend_js_1 = require("./whatsappSend.js");
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_CONV_TURNS = 40;
const RESET_COMMANDS = [
    "reset thread",
    "reset session",
    "clear thread",
    "/reset",
    "new session",
];
const JAHAN_E164 = "+17373461943";
const chatSessions = new Map();
function getOpenClawSession(sessionId) {
    const session = chatSessions.get(sessionId);
    if (!session) {
        return { sessionId, exists: false, messageCount: 0, createdAt: null };
    }
    return {
        sessionId,
        exists: true,
        messageCount: session.conv.length,
        createdAt: session.createdAt,
    };
}
function resetOpenClawSession(sessionId) {
    return chatSessions.delete(sessionId);
}
function normalizeE164(input) {
    const raw = input.trim().replace(/[^\d+]/g, "");
    if (!raw)
        return "";
    if (raw.startsWith("+"))
        return raw;
    if (raw.length === 10)
        return `+1${raw}`;
    if (raw.length === 11 && raw.startsWith("1"))
        return `+${raw}`;
    return `+${raw}`;
}
function stripOpenClawEnvelope(message) {
    const marker = "Conversation info (untrusted metadata)";
    if (!message.includes(marker))
        return message.trim();
    const parts = message.split("```");
    if (parts.length >= 3) {
        const after = parts.slice(2).join("```").trim();
        if (after)
            return after;
    }
    return message.trim();
}
function parseOpenClawMetadata(rawMessage) {
    const marker = "Conversation info (untrusted metadata)";
    if (!rawMessage.includes(marker))
        return null;
    const parts = rawMessage.split("```");
    for (const part of parts) {
        const trimmed = part.trim().replace(/^json\s*/i, "").trim();
        if (!trimmed.startsWith("{"))
            continue;
        try {
            return JSON.parse(trimmed);
        }
        catch {
            /* ignore */
        }
    }
    return null;
}
function parseOpenClawPeer(rawMessage, body) {
    const meta = parseOpenClawMetadata(rawMessage);
    if (meta) {
        const peer = meta.peer;
        if (peer?.id)
            return normalizeE164(String(peer.id));
        if (typeof meta.sender === "string")
            return normalizeE164(meta.sender);
        if (typeof meta.from === "string")
            return normalizeE164(meta.from);
        if (typeof meta.senderE164 === "string")
            return normalizeE164(meta.senderE164);
    }
    if (typeof body.user === "string" && body.user.trim()) {
        return normalizeE164(body.user.trim());
    }
    return "harvey";
}
function buildChannelContext(peerId) {
    if (peerId === JAHAN_E164) {
        return "CHANNEL: WhatsApp DM from Jahan (+17373461943), Aethon/automation. He is an authorized contact. Answer as Harvey, Marco's assistant. He can say 'Hey Harvey' or ask anything directly — no special activation code.";
    }
    return undefined;
}
function parseOpenClawUserMessage(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const lastUser = [...list].reverse().find((m) => m && typeof m === "object" && m.role === "user");
    if (!lastUser)
        return "";
    const content = lastUser.content;
    if (typeof content === "string")
        return content.trim();
    if (Array.isArray(content)) {
        return content
            .filter((b) => b && typeof b === "object" && b.type === "text")
            .map((b) => String(b.text || ""))
            .join(" ")
            .trim();
    }
    return "";
}
function getOrRefreshSession(sessionId) {
    let session = chatSessions.get(sessionId);
    if (session && Date.now() - session.createdAt > SESSION_TTL_MS) {
        chatSessions.delete(sessionId);
        session = undefined;
    }
    if (!session) {
        session = { conv: [], createdAt: Date.now() };
        chatSessions.set(sessionId, session);
    }
    return session;
}
function trimConv(conv) {
    while (conv.length > MAX_CONV_TURNS * 2)
        conv.shift();
}
function openAiCompletionResponse(content, idPrefix = "harvey") {
    return {
        id: `${idPrefix}-${Date.now()}`,
        object: "chat.completion",
        model: "harvey",
        choices: [
            {
                index: 0,
                message: { role: "assistant", content },
                finish_reason: "stop",
            },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
}
async function handleOpenClawChatCompletions(body) {
    const messages = body.messages || [];
    const rawMessage = parseOpenClawUserMessage(messages);
    const message = stripOpenClawEnvelope(rawMessage);
    const peerId = parseOpenClawPeer(rawMessage, body);
    const sessionId = `wa:${peerId}`;
    const ownerNumber = (0, whatsappSend_js_1.getHarveyOwnerNumber)();
    const isOwner = peerId === ownerNumber;
    console.log("[openclaw] /v1/chat/completions", {
        sessionId,
        peerId,
        isOwner,
        messageCount: messages.length,
        lastMessage: message.slice(0, 80),
    });
    if (!message) {
        return { status: 400, json: { error: "message required" } };
    }
    const isReset = RESET_COMMANDS.some((cmd) => message.toLowerCase().trim() === cmd);
    if (isReset) {
        const session = chatSessions.get(sessionId);
        if (session && session.conv.length >= 2) {
            const transcript = session.conv.map((m) => ({
                role: m.role,
                text: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            }));
            void (0, extraction_js_1.runPostConversationExtraction)(sessionId, transcript);
        }
        chatSessions.delete(sessionId);
        return {
            status: 200,
            json: openAiCompletionResponse("Thread cleared. Memory saved. Fresh start.", "reset"),
        };
    }
    const session = getOrRefreshSession(sessionId);
    const history = [...session.conv];
    try {
        const result = await (0, agentLoop_js_1.runAgentLoop)({
            message,
            history,
            fastMode: true,
            ownerMode: isOwner,
            channelContext: buildChannelContext(peerId),
        });
        session.conv.push({ role: "user", content: message });
        session.conv.push({ role: "assistant", content: result.speech });
        trimConv(session.conv);
        const transcript = [
            { role: "user", text: message },
            { role: "assistant", text: result.speech },
        ];
        void (0, extraction_js_1.runPostConversationExtraction)(sessionId, transcript);
        return { status: 200, json: openAiCompletionResponse(result.speech) };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[openclaw] chat error:", msg);
        return { status: 500, json: { error: msg || "chat failed" } };
    }
}
