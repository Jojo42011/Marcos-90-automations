import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";

const DEEPGRAM_LISTEN = "wss://api.deepgram.com/v2/listen";

export function deepgramListenUrl(): string {
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

export function handleDeepgramUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  tokenOk: (req: IncomingMessage) => boolean,
): boolean {
  const url = request.url || "";
  if (!url.includes("/api/jarvis/deepgram/listen")) return false;

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
  const dgWs = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${key}` },
  });

  let clientWs: WebSocket | null = null;

  const wss = new WebSocketServer({ noServer: true });

  wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
    clientWs = ws;

    dgWs.on("open", () => {
      console.log("[hull/deepgram] Flux proxy connected");
      if (clientWs?.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: "Connected", source: "proxy" }));
      }
    });

    dgWs.on("message", (data, isBinary) => {
      if (clientWs?.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });

    dgWs.on("close", () => {
      if (clientWs?.readyState === WebSocket.OPEN) clientWs.close();
    });

    dgWs.on("error", (err) => {
      console.error("[hull/deepgram] upstream error:", err.message);
      if (clientWs?.readyState === WebSocket.OPEN) clientWs.close();
    });

    ws.on("message", (data, isBinary) => {
      if (dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(data, { binary: isBinary });
      }
    });

    ws.on("close", () => {
      if (dgWs.readyState === WebSocket.OPEN) dgWs.close();
    });

    ws.on("error", () => {
      if (dgWs.readyState === WebSocket.OPEN) dgWs.close();
    });
  });

  return true;
}
