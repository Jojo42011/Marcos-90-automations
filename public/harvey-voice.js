/**
 * Harvey continuous voice — tap mic once, talk / hear / talk again.
 * Expects window.HarveyVoice.init(deps) from jarvis.html after chat helpers exist.
 */
(function () {
  function voiceDebugOn() {
    try {
      return (
        localStorage.getItem("HARVEY_VOICE_DEBUG") === "1" ||
        new URLSearchParams(window.location.search).get("voice_debug") === "1"
      );
    } catch {
      return false;
    }
  }

  function vlog(...args) {
    if (voiceDebugOn()) console.log("[HarveyVoice:client]", ...args);
  }

  if (voiceDebugOn()) {
    console.log("[HarveyVoice:client] Browser voice logging ON (?voice_debug=1 or localStorage HARVEY_VOICE_DEBUG=1)");
  }

  const COMMIT_AFTER_FINAL_MS = 1500;
  const COMMIT_AFTER_UTTERANCE_MS = 600;
  const RMS_SPEECH = 0.018;
  const TARGET_RATE = 16000;

  let deps = null;
  let conversationMode = false;
  let listening = false;
  let phase = "STANDBY";
  let speechToken = 0;
  let isSpeaking = false;
  /** Single session AudioContext — created on core tap only, reused for all TTS. */
  let audioContext = null;
  let currentSource = null;
  let pendingManageUi = false;

  let mediaStream = null;
  let captureCtx = null;
  let processor = null;
  let analyser = null;
  let dgSocket = null;
  let intentionalClose = false;
  let reconnectAttempt = 0;

  let utteranceSegments = [];
  let utteranceInterim = "";
  let commitTimer = null;
  let isSpeakingRms = false;

  function setPhase(p) {
    phase = p;
    if (deps?.setStatus) deps.setStatus(p, p !== "STANDBY");
  }

  function canCommit() {
    return conversationMode && phase === "LISTENING" && listening;
  }

  function clearCommitTimer() {
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
  }

  function scheduleCommit(delayMs) {
    if (!canCommit()) return;
    clearCommitTimer();
    commitTimer = setTimeout(() => {
      commitTimer = null;
      if (!canCommit() || isSpeakingRms) return;
      const text = buildTranscript();
      if (text.trim()) void finishTranscript(text);
    }, delayMs);
  }

  function onSpeechActivity() {
    if (!canCommit()) return;
    clearCommitTimer();
  }

  function buildTranscript() {
    const finals = utteranceSegments.join(" ").trim();
    const interim = utteranceInterim.trim();
    if (!finals) return interim;
    if (!interim) return finals;
    if (finals.includes(interim) || interim.includes(finals)) return finals.length >= interim.length ? finals : interim;
    return (finals + " " + interim).trim();
  }

  function appendFinalSegment(t) {
    const s = String(t || "").trim();
    if (!s) return;
    const last = utteranceSegments[utteranceSegments.length - 1];
    if (last === s) return;
    if (last && s.startsWith(last)) utteranceSegments[utteranceSegments.length - 1] = s;
    else utteranceSegments.push(s);
  }

  function handleDeepgramMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const type = msg.type;
    if (type === "Results" || type === "UtteranceEnd" || type === "SpeechStarted") {
      const alt = msg.channel?.alternatives?.[0];
      vlog("STT event", { type, is_final: msg.is_final, transcript: (alt?.transcript || "").slice(0, 80) });
    }
    if (type === "SpeechStarted") {
      onSpeechActivity();
      return;
    }
    if (type === "UtteranceEnd") {
      scheduleCommit(COMMIT_AFTER_UTTERANCE_MS);
      return;
    }
    const alt = msg.channel?.alternatives?.[0];
    const transcript = alt?.transcript?.trim() || "";
    if (!transcript) return;
    if (msg.is_final) {
      appendFinalSegment(transcript);
      utteranceInterim = "";
      scheduleCommit(COMMIT_AFTER_FINAL_MS);
    } else {
      utteranceInterim = transcript;
      onSpeechActivity();
      if (deps?.showInterim) deps.showInterim(buildTranscript());
    }
  }

  function floatToInt16(float32, out) {
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }

  /** Downsample float32 mic frames → linear16 LE PCM at 16 kHz (Deepgram encoding=linear16). */
  function resampleTo16k(float32, inRate) {
    if (!float32?.length) return new ArrayBuffer(0);
    if (inRate === TARGET_RATE) {
      const out = new Int16Array(float32.length);
      floatToInt16(float32, out);
      return out.buffer;
    }
    const outLen = Math.max(1, Math.round((float32.length * TARGET_RATE) / inRate));
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcPos = (i * inRate) / TARGET_RATE;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;
      const s0 = float32[idx] ?? 0;
      const s1 = float32[Math.min(idx + 1, float32.length - 1)] ?? s0;
      const s = Math.max(-1, Math.min(1, s0 + frac * (s1 - s0)));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out.buffer;
  }

  async function ensureCaptureCtxReady() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!captureCtx) {
      try {
        captureCtx = new Ctx({ sampleRate: TARGET_RATE });
      } catch {
        captureCtx = new Ctx();
      }
    }
    if (captureCtx.state === "suspended") await captureCtx.resume();
    vlog("captureCtx ready", { state: captureCtx.state, sampleRate: captureCtx.sampleRate });
  }

  /** Must run inside user gesture (core tap) before any TTS. */
  async function initAudioContextOnTap() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error("Web Audio not supported");
    if (!audioContext) {
      audioContext = new Ctx({ sampleRate: 44100 });
      vlog("AudioContext created", { sampleRate: audioContext.sampleRate });
    }
    audioContext.resume();
    await audioContext.resume();
    vlog("AudioContext resumed", { state: audioContext.state });
  }

  function haltPlayback() {
    speechToken += 1;
    try {
      currentSource?.stop();
    } catch {
      /* */
    }
    currentSource = null;
  }

  async function speak(text, manageUi) {
    if (isSpeaking) {
      vlog("speak ignored — already in flight");
      return;
    }
    const speechText = String(text || "").trim();
    pendingManageUi = !!manageUi;
    if (!speechText) {
      if (manageUi && conversationMode) setPhase("STANDBY");
      return;
    }
    if (!audioContext) {
      throw new Error("AudioContext not ready — tap the core to start voice");
    }

    isSpeaking = true;
    haltPlayback();
    const token = speechToken;
    if (manageUi) setPhase("RESPONDING");
    vlog("TTS start", { chars: speechText.length, manageUi, token, speechToken });

    try {
      const response = await fetch(deps.apiUrl("/api/jarvis/voice"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: speechText }),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        vlog("TTS HTTP error", { status: response.status, error: errBody.error || response.statusText });
        throw new Error(errBody.error || response.statusText);
      }

      const arrayBuffer = await response.arrayBuffer();
      vlog("TTS ok", { bytes: arrayBuffer.byteLength });
      if (token !== speechToken) {
        console.log("[HarveyVoice:client] token mismatch — bailing", { token, speechToken });
        return;
      }

      console.log("[HarveyVoice:client] audio playing");

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      if (token !== speechToken) {
        console.log("[HarveyVoice:client] token mismatch — bailing", { token, speechToken });
        return;
      }

      const source = audioContext.createBufferSource();
      source.buffer = decoded;
      source.connect(audioContext.destination);
      currentSource = source;
      source.onended = () => {
        console.log("[HarveyVoice:client] audio ended");
        vlog("audio ended", { durationSec: decoded.duration });
        currentSource = null;
        if (token !== speechToken) return;
        setPhase("STANDBY");
        scheduleListeningRestart();
      };
      vlog("audio playing", { durationSec: decoded.duration, ctxState: audioContext.state });
      source.start(0);
    } catch (e) {
      vlog("TTS failed", { error: e.message || String(e) });
      console.warn("[HarveyVoice:client] TTS playback failed:", e.message || e);
      if (manageUi) {
        deps.addMsg("system", "TTS failed: " + (e.message || e));
        setPhase("STANDBY");
      }
    } finally {
      isSpeaking = false;
    }
  }

  function cleanupListening() {
    intentionalClose = true;
    listening = false;
    clearCommitTimer();
    try {
      processor?.disconnect();
    } catch {
      /* */
    }
    processor = null;
    try {
      captureCtx?.close();
    } catch {
      /* */
    }
    captureCtx = null;
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    if (dgSocket) {
      try {
        if (dgSocket.readyState === WebSocket.OPEN) {
          dgSocket.send(JSON.stringify({ type: "CloseStream" }));
        }
      } catch {
        /* */
      }
      try {
        dgSocket.close();
      } catch {
        /* */
      }
      dgSocket = null;
    }
    intentionalClose = false;
    utteranceSegments = [];
    utteranceInterim = "";
  }

  async function openDeepgramSocket() {
    vlog("STT token fetch");
    const tokRes = await fetch(deps.apiUrl("/api/jarvis/deepgram/token"));
    const tok = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok) {
      vlog("STT token failed", { status: tokRes.status, error: tok.error });
      throw new Error(tok.error || "STT token failed");
    }
    const listenPath = tok.url || "/api/jarvis/deepgram/listen";
    const wsBase = deps.apiUrl(listenPath);
    const wsUrl = wsBase.replace(/^http/, "ws");
    vlog("STT WebSocket connect", { wsUrl: wsUrl.replace(/token=[^&]+/, "token=***") });
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      let settled = false;
      ws.onopen = () => {
        vlog("STT WebSocket open");
        reconnectAttempt = 0;
        if (!settled) {
          settled = true;
          resolve(ws);
        }
      };
      ws.onerror = () => {
        vlog("STT WebSocket error");
        if (!settled) {
          settled = true;
          reject(new Error("Deepgram socket error"));
        }
      };
      ws.onclose = (ev) => {
        vlog("STT WebSocket close", { code: ev.code, reason: ev.reason, intentionalClose });
        if (!intentionalClose && conversationMode && phase === "LISTENING") {
          void reconnectListen();
        }
      };
      ws.onmessage = handleDeepgramMessage;
      dgSocket = ws;
    });
  }

  async function reconnectListen() {
    if (!conversationMode || phase !== "LISTENING") return;
    if (reconnectAttempt >= 8) {
      deps.addMsg("system", "Voice connection lost. Tap mic to retry.");
      conversationMode = false;
      setPhase("STANDBY");
      cleanupListening();
      return;
    }
    const delay = Math.min(8000, 500 * Math.pow(2, reconnectAttempt++));
    await new Promise((r) => setTimeout(r, delay));
    if (!conversationMode) return;
    try {
      await openDeepgramSocket();
    } catch {
      void reconnectListen();
    }
  }

  async function startListening(fromTap) {
    if (!deps) return;
    if (phase === "PROCESSING" || phase === "RESPONDING") return;
    if (listening) return;

    vlog("startListening", { fromTap });
    setPhase("LISTENING");
    listening = true;
    utteranceSegments = [];
    utteranceInterim = "";

    await openDeepgramSocket();

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      vlog("mic granted");
    } catch (micErr) {
      vlog("mic denied", { error: micErr.message || String(micErr) });
      throw micErr;
    }

    await ensureCaptureCtxReady();

    const input = captureCtx.createMediaStreamSource(mediaStream);
    analyser = captureCtx.createAnalyser();
    analyser.fftSize = 512;
    input.connect(analyser);

    const muteOut = captureCtx.createGain();
    muteOut.gain.value = 0;

    processor = captureCtx.createScriptProcessor(4096, 1, 1);
    input.connect(processor);
    processor.connect(muteOut);
    muteOut.connect(captureCtx.destination);

    const inRate = captureCtx.sampleRate;
    const rmsBuf = new Float32Array(analyser.fftSize);
    let pcmChunks = 0;

    processor.onaudioprocess = (e) => {
      if (!listening || !dgSocket || dgSocket.readyState !== WebSocket.OPEN) return;
      const ch = e.inputBuffer.getChannelData(0);
      const pcm = resampleTo16k(ch, inRate);
      if (!pcm.byteLength) return;
      dgSocket.send(pcm);
      pcmChunks += 1;
      if (pcmChunks === 1 || pcmChunks % 50 === 0) {
        vlog("PCM → STT", { chunk: pcmChunks, bytes: pcm.byteLength, inRate, target: TARGET_RATE });
      }
      analyser.getFloatTimeDomainData(rmsBuf);
      let sum = 0;
      for (let i = 0; i < rmsBuf.length; i++) sum += rmsBuf[i] * rmsBuf[i];
      const rms = Math.sqrt(sum / rmsBuf.length);
      if (rms > RMS_SPEECH) {
        isSpeakingRms = true;
        onSpeechActivity();
      } else {
        isSpeakingRms = false;
      }
    };
  }

  function scheduleListeningRestart() {
    if (!conversationMode || listening || phase !== "STANDBY") return;
    void startListening(false);
  }

  async function finishTranscript(text) {
    if (!text.trim()) return;
    if (phase === "PROCESSING" || phase === "RESPONDING") return;
    vlog("commit transcript", { text: text.trim().slice(0, 120) });
    cleanupListening();
    setPhase("PROCESSING");
    if (deps.showInterim) deps.showInterim("");
    deps.addMsg("user", text.trim());

    try {
      const body = await deps.sendChat(text.trim());
      const speech = body.speech || body.reply || "";
      if (body.directives) deps.renderDirectives(body.directives);
      if (body.metrics) deps.renderMetrics(body.metrics);
      const el = deps.addMsg("ai", speech, false);
      if (el) el.textContent = speech;
      if (conversationMode && speech) await speak(speech, true);
      else setPhase("STANDBY");
    } catch (e) {
      vlog("chat error", { error: e.message || String(e) });
      deps.addMsg("system", "Error: " + (e.message || e));
      setPhase("STANDBY");
      if (conversationMode) scheduleListeningRestart();
    }
  }

  async function toggleConversation() {
    if (!deps) return;
    if (conversationMode) {
      vlog("end conversation");
      conversationMode = false;
      haltPlayback();
      cleanupListening();
      setPhase("STANDBY");
      deps.setMicActive(false);
      return;
    }
    conversationMode = true;
    deps.setMicActive(true);
    vlog("start conversation");
    try {
      await initAudioContextOnTap();
      await startListening(true);
    } catch (e) {
      vlog("startListening failed", { error: e.message || String(e) });
      conversationMode = false;
      deps.setMicActive(false);
      setPhase("STANDBY");
      deps.addMsg("system", "Voice error: " + (e.message || e));
    }
  }

  window.HarveyVoice = {
    init(d) {
      deps = d;
    },
    toggleConversation,
    speak,
    isConversationMode: () => conversationMode,
    haltPlayback,
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && conversationMode && !listening && phase === "STANDBY") {
      if (audioContext) {
        void audioContext.resume().then(() => scheduleListeningRestart());
      } else {
        scheduleListeningRestart();
      }
    }
  });
})();
