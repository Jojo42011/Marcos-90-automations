"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JARVIS_DEEPGRAM_LISTEN_PATH = void 0;
exports.isDeepgramSttConfigured = isDeepgramSttConfigured;
exports.attachDeepgramSttProxy = attachDeepgramSttProxy;
const ws_1 = require("ws");
const voiceLog_js_1 = require("../voice/voiceLog.js");
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
        smart_format: "true",
        punctuate: "true",
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
            (0, voiceLog_js_1.voiceLog)("STT upgrade rejected: unauthorized");
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }
        if (!isDeepgramSttConfigured()) {
            (0, voiceLog_js_1.voiceLog)("STT upgrade rejected: DEEPGRAM_API_KEY missing");
            socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
            socket.destroy();
            return;
        }
        (0, voiceLog_js_1.voiceLog)("STT WebSocket upgrade accepted");
        wss.handleUpgrade(req, socket, head, (clientWs) => {
            const dgKey = process.env.DEEPGRAM_API_KEY.trim();
            const endpointingMs = process.env.DEEPGRAM_ENDPOINTING_MS?.trim() || "1000";
            const utteranceEndMs = process.env.DEEPGRAM_UTTERANCE_END_MS?.trim() || "3000";
            let upstream = null;
            const pending = [];
            const flushPending = () => {
                if (!upstream || upstream.readyState !== ws_1.WebSocket.OPEN)
                    return;
                for (const chunk of pending)
                    upstream.send(chunk, { binary: true });
                pending.length = 0;
            };
            try {
                upstream = new ws_1.WebSocket(buildDeepgramUpstreamUrl(), {
                    headers: { Authorization: `Token ${dgKey}` },
                });
            }
            catch (err) {
                (0, voiceLog_js_1.voiceLog)("STT upstream connect threw", {
                    error: err instanceof Error ? err.message : String(err),
                });
                clientWs.close(1011, "STT upstream failed");
                return;
            }
            let audioBytesToDg = 0;
            let dgTextEvents = 0;
            upstream.on("open", () => {
                (0, voiceLog_js_1.voiceLog)("STT Deepgram upstream open", {
                    encoding: "linear16",
                    sample_rate: 16000,
                    endpointing: endpointingMs,
                    utterance_end_ms: utteranceEndMs,
                });
                flushPending();
            });
            upstream.on("message", (data, isBinary) => {
                if (isBinary) {
                    /* audio from DG not expected on listen */
                }
                else {
                    try {
                        const j = JSON.parse(data.toString());
                        if (j.type === "Results" || j.type === "UtteranceEnd" || j.type === "SpeechStarted") {
                            dgTextEvents += 1;
                            const transcript = j.channel?.alternatives?.[0]?.transcript ?? "";
                            const confidence = j.channel?.alternatives?.[0]?.confidence;
                            if (dgTextEvents <= 30 || j.type !== "Results" || transcript) {
                                (0, voiceLog_js_1.voiceLog)("STT Deepgram → client", {
                                    type: j.type,
                                    is_final: j.is_final,
                                    speech_final: j.speech_final,
                                    transcript: transcript.slice(0, 120),
                                    confidence,
                                });
                            }
                        }
                    }
                    catch {
                        /* ignore non-json */
                    }
                }
                if (clientWs.readyState === ws_1.WebSocket.OPEN) {
                    clientWs.send(data, { binary: isBinary });
                }
            });
            clientWs.on("message", (data, isBinary) => {
                if (!isBinary) {
                    (0, voiceLog_js_1.voiceLog)("STT client sent text (ignored for audio)", {
                        preview: data.toString().slice(0, 80),
                    });
                    return;
                }
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
                audioBytesToDg += buf.length;
                if (upstream?.readyState === ws_1.WebSocket.OPEN)
                    upstream.send(buf, { binary: true });
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
            upstream.on("close", (code, reason) => {
                (0, voiceLog_js_1.voiceLog)("STT Deepgram upstream closed", {
                    code,
                    reason: reason?.toString() || "",
                    audioBytesToDg,
                    dgTextEvents,
                });
                try {
                    clientWs.close();
                }
                catch {
                    /* */
                }
            });
            upstream.on("error", (err) => {
                (0, voiceLog_js_1.voiceLog)("STT Deepgram upstream error", {
                    error: err instanceof Error ? err.message : String(err),
                });
                try {
                    clientWs.close(1011, "upstream error");
                }
                catch {
                    /* */
                }
                closeUpstream();
            });
            clientWs.on("close", () => {
                (0, voiceLog_js_1.voiceLog)("STT client WebSocket closed", { audioBytesToDg, dgTextEvents });
                closeUpstream();
            });
            clientWs.on("error", (err) => {
                (0, voiceLog_js_1.voiceLog)("STT client WebSocket error", {
                    error: err instanceof Error ? err.message : String(err),
                });
                closeUpstream();
            });
        });
    });
}
