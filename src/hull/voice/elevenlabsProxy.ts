/**
 * ElevenLabs Scribe v2 Realtime STT proxy for Harvey's voice.
 *
 * Mirrors deepgramProxy.ts: the browser (aethon-voice.js) opens a same-origin
 * WebSocket to /api/jarvis/elevenlabs/listen and streams 16 kHz PCM16 mic frames
 * as binary. This proxy relays them to ElevenLabs' realtime STT WebSocket
 * (auth stays server-side via xi-api-key), and translates ElevenLabs' messages
 * back into the EXACT message shape the client already understands (the Deepgram
 * "Flux" turn contract: {type:"Connected"} and {type:"TurnInfo", event,
 * transcript, turn_index}). Translating here means the client's barge-in and
 * turn-taking logic is untouched — it never learns which STT vendor is behind
 * the proxy.
 *
 * ElevenLabs realtime STT (confirmed against the API reference):
 *   URL   : wss://api.elevenlabs.io/v1/speech-to-text/realtime
 *   query : model_id, audio_format=pcm_16000, commit_strategy=vad, vad params
 *   auth  : header  xi-api-key: <ELEVENLABS_API_KEY>
 *   send  : {message_type:"input_audio_chunk", audio_base_64:"<b64 pcm16>", sample_rate:16000}
 *   recv  : {message_type:"session_started"}
 *           {message_type:"partial_transcript",   text:"..."}   (interim)
 *           {message_type:"committed_transcript", text:"..."}   (final)
 */
import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";

const ELEVENLABS_REALTIME = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

export function elevenLabsListenUrl(): string {
  const model = process.env.ELEVENLABS_STT_MODEL_ID?.trim() || "scribe_v2_realtime";
  // Silence window that closes a turn. Deepgram Flux used ~0.7s eot; keep the
  // ElevenLabs VAD close to that for comparable end-of-turn snappiness.
  const silence = process.env.ELEVENLABS_STT_SILENCE_SECS?.trim() || "0.8";
  const params = new URLSearchParams({
    model_id: model,
    audio_format: "pcm_16000",
    commit_strategy: "vad", // server-side VAD auto-commits a turn on silence
    vad_silence_threshold_secs: silence,
    vad_threshold: "0.4",
  });
  return `${ELEVENLABS_REALTIME}?${params}`;
}

export function handleElevenLabsUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  tokenOk: (req: IncomingMessage) => boolean,
): boolean {
  const url = request.url || "";
  if (!url.includes("/api/jarvis/elevenlabs/listen")) return false;

  if (!tokenOk(request)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return true;
  }

  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    return true;
  }

  const elWs = new WebSocket(elevenLabsListenUrl(), {
    headers: { "xi-api-key": key },
  });

  let clientWs: WebSocket | null = null;
  // Turn tracking so we can reconstruct the client's StartOfTurn/EndOfTurn
  // contract from ElevenLabs' partial/committed transcripts.
  let inTurn = false;
  let turnIndex = 0;

  const sendClient = (obj: unknown) => {
    if (clientWs?.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(obj));
  };

  const wss = new WebSocketServer({ noServer: true });

  wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
    clientWs = ws;

    elWs.on("open", () => {
      console.log("[hull/elevenlabs] Scribe v2 realtime proxy connected");
      // Client shows LISTENING on "Connected"/"ready" — same as the Deepgram path.
      sendClient({ type: "Connected", source: "proxy" });
    });

    elWs.on("message", (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // non-JSON frame — ignore
      }
      const mt = String(msg.message_type || msg.type || "");
      const text = typeof msg.text === "string" ? msg.text : "";

      if (mt === "session_started") {
        // Already sent Connected on open; nothing more needed.
        return;
      }
      if (mt === "partial_transcript") {
        if (!inTurn) {
          // First partial of a new turn → StartOfTurn (drives barge-in when
          // Harvey is speaking), immediately followed by the interim text.
          inTurn = true;
          sendClient({ type: "TurnInfo", event: "StartOfTurn", transcript: text, turn_index: turnIndex });
        }
        sendClient({ type: "TurnInfo", event: "Update", transcript: text, turn_index: turnIndex });
        return;
      }
      if (mt === "committed_transcript" || mt === "committed_transcript_with_timestamps") {
        // Final transcript for this turn → EndOfTurn (client commits it).
        sendClient({ type: "TurnInfo", event: "EndOfTurn", transcript: text, turn_index: turnIndex });
        inTurn = false;
        turnIndex += 1;
        return;
      }
      // Ignore any other ElevenLabs control frames.
    });

    elWs.on("close", () => {
      if (clientWs?.readyState === WebSocket.OPEN) clientWs.close();
    });

    elWs.on("error", (err) => {
      console.error("[hull/elevenlabs] upstream error:", err.message);
      if (clientWs?.readyState === WebSocket.OPEN) clientWs.close();
    });

    // Client → ElevenLabs: wrap raw PCM16 binary frames as base64 input_audio_chunk.
    ws.on("message", (data, isBinary) => {
      if (elWs.readyState !== WebSocket.OPEN) return;
      if (isBinary) {
        const buf = Array.isArray(data) ? Buffer.concat(data) : (data as Buffer);
        elWs.send(
          JSON.stringify({
            message_type: "input_audio_chunk",
            audio_base_64: buf.toString("base64"),
            sample_rate: 16000,
          }),
        );
      }
      // Text control frames from the client (if any) are not part of the audio
      // stream — drop them rather than forwarding raw.
    });

    ws.on("close", () => {
      if (elWs.readyState === WebSocket.OPEN) elWs.close();
    });

    ws.on("error", () => {
      if (elWs.readyState === WebSocket.OPEN) elWs.close();
    });
  });

  return true;
}
