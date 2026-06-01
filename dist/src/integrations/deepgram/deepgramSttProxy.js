"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JARVIS_DEEPGRAM_LISTEN_PATH = void 0;
exports.isDeepgramSttConfigured = isDeepgramSttConfigured;
exports.attachDeepgramSttProxy = attachDeepgramSttProxy;
const ws_1 = require("ws");
exports.JARVIS_DEEPGRAM_LISTEN_PATH = "/api/jarvis/deepgram/listen";
function buildDeepgramUpstreamUrl() {
    const endpointing = process.env.DEEPGRAM_ENDPOINTING_MS?.trim() || "1000";
    const utteranceEnd = process.env.DEEPGRAM_UTTERANCE_END_MS?.trim() || "3000";
    const qs = new URLSearchParams({
        model: "nova-2",
        language: "en-US",
        encoding: "linear16",
        sample_rate: "16000",
        channels: "1",
        interim_results: "true",
        vad_events: "true",
        endpointing,
        utterance_end_ms: utteranceEnd,
    });
    return `wss://api.deepgram.com/v1/listen?${qs.toString()}`;
}
function isDeepgramSttConfigured() {
    return Boolean(process.env.DEEPGRAM_API_KEY?.trim());
}
function attachDeepgramSttProxy(server, opts) {
    const listenPath = opts.path ?? exports.JARVIS_DEEPGRAM_LISTEN_PATH;
    const wss = new ws_1.WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
        let pathname = "";
        try {
            const host = req.headers.host || "localhost";
            pathname = new URL(req.url || "/", `http://${host}`).pathname;
        }
        catch {
            return;
        }
        if (pathname !== listenPath)
            return;
        if (!opts.isAuthorized(req)) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }
        if (!isDeepgramSttConfigured()) {
            socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (clientWs) => {
            const dgKey = process.env.DEEPGRAM_API_KEY.trim();
            let upstream = null;
            const pending = [];
            const flushPending = () => {
                if (!upstream || upstream.readyState !== ws_1.WebSocket.OPEN)
                    return;
                for (const chunk of pending)
                    upstream.send(chunk);
                pending.length = 0;
            };
            try {
                upstream = new ws_1.WebSocket(buildDeepgramUpstreamUrl(), {
                    headers: { Authorization: `Token ${dgKey}` },
                });
            }
            catch {
                clientWs.close(1011, "STT upstream failed");
                return;
            }
            upstream.on("open", () => {
                flushPending();
            });
            upstream.on("message", (data, isBinary) => {
                if (clientWs.readyState === ws_1.WebSocket.OPEN) {
                    clientWs.send(data, { binary: isBinary });
                }
            });
            clientWs.on("message", (data) => {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
                if (upstream?.readyState === ws_1.WebSocket.OPEN)
                    upstream.send(buf);
                else
                    pending.push(buf);
            });
            const closeUpstream = () => {
                try {
                    upstream?.close();
                }
                catch {
                    /* */
                }
                upstream = null;
            };
            upstream.on("close", () => {
                try {
                    clientWs.close();
                }
                catch {
                    /* */
                }
            });
            upstream.on("error", () => {
                try {
                    clientWs.close(1011, "upstream error");
                }
                catch {
                    /* */
                }
                closeUpstream();
            });
            clientWs.on("close", closeUpstream);
            clientWs.on("error", closeUpstream);
        });
    });
}
