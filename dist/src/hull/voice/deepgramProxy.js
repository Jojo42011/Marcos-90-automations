"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deepgramListenUrl = deepgramListenUrl;
exports.handleDeepgramUpgrade = handleDeepgramUpgrade;
const ws_1 = require("ws");
const DEEPGRAM_LISTEN = "wss://api.deepgram.com/v2/listen";
function deepgramListenUrl() {
    const model = process.env.DEEPGRAM_MODEL?.trim() || "flux-general-en";
    const params = new URLSearchParams({
        model,
        encoding: "linear16",
        sample_rate: "16000",
        eot_threshold: "0.7",
        eager_eot_threshold: "0.65",
        eot_timeout_ms: "8000",
    });
    return `${DEEPGRAM_LISTEN}?${params}`;
}
function handleDeepgramUpgrade(request, socket, head, tokenOk) {
    const url = request.url || "";
    if (!url.includes("/api/jarvis/deepgram/listen"))
        return false;
    if (!tokenOk(request)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return true;
    }
    const key = process.env.DEEPGRAM_API_KEY?.trim();
    if (!key) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return true;
    }
    const dgUrl = deepgramListenUrl();
    const dgWs = new ws_1.WebSocket(dgUrl, {
        headers: { Authorization: `Token ${key}` },
    });
    let clientWs = null;
    const wss = new ws_1.WebSocketServer({ noServer: true });
    wss.handleUpgrade(request, socket, head, (ws) => {
        clientWs = ws;
        dgWs.on("open", () => {
            console.log("[hull/deepgram] Flux proxy connected");
            if (clientWs?.readyState === ws_1.WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type: "Connected", source: "proxy" }));
            }
        });
        dgWs.on("message", (data, isBinary) => {
            if (clientWs?.readyState === ws_1.WebSocket.OPEN) {
                clientWs.send(data, { binary: isBinary });
            }
        });
        dgWs.on("close", () => {
            if (clientWs?.readyState === ws_1.WebSocket.OPEN)
                clientWs.close();
        });
        dgWs.on("error", (err) => {
            console.error("[hull/deepgram] upstream error:", err.message);
            if (clientWs?.readyState === ws_1.WebSocket.OPEN)
                clientWs.close();
        });
        ws.on("message", (data, isBinary) => {
            if (dgWs.readyState === ws_1.WebSocket.OPEN) {
                dgWs.send(data, { binary: isBinary });
            }
        });
        ws.on("close", () => {
            if (dgWs.readyState === ws_1.WebSocket.OPEN)
                dgWs.close();
        });
        ws.on("error", () => {
            if (dgWs.readyState === ws_1.WebSocket.OPEN)
                dgWs.close();
        });
    });
    return true;
}
