/**
 * Harvey continuous voice — tap mic once, talk / hear / talk again.
 * Expects window.HarveyVoice.init(deps) from jarvis.html after chat helpers exist.
 */
(function () {
  const COMMIT_AFTER_FINAL_MS = 1500;
  const COMMIT_AFTER_UTTERANCE_MS = 600;
  const RMS_SPEECH = 0.018;
  const TARGET_RATE = 16000;

  let deps = null;
  let conversationMode = false;
  let listening = false;
  let phase = "STANDBY";
  let speechToken = 0;
  let playbackCtx = null;
  let currentSource = null;

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

  function resampleTo16k(float32, inRate) {
    if (inRate === TARGET_RATE) {
      const out = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out.buffer;
    }
    const ratio = inRate / TARGET_RATE;
    const outLen = Math.floor(float32.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = Math.floor(i * ratio);
      const s = Math.max(-1, Math.min(1, float32[idx] || 0));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out.buffer;
  }

  async function unlockAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!playbackCtx) playbackCtx = new Ctx();
    if (playbackCtx.state === "suspended") await playbackCtx.resume();
    const buf = playbackCtx.createBuffer(1, 1, TARGET_RATE);
    const src = playbackCtx.createBufferSource();
    src.buffer = buf;
    src.connect(playbackCtx.destination);
    src.start(0);
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
    const token = ++speechToken;
    haltPlayback();
    const clean = String(text || "").trim();
    if (!clean) return;
    if (manageUi) setPhase("RESPONDING");

    try {
      const res = await fetch(deps.apiUrl("/api/jarvis/voice"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const buf = await res.arrayBuffer();
      if (token !== speechToken) return;
      if (!playbackCtx) await unlockAudio();
      const audioBuf = await playbackCtx.decodeAudioData(buf.slice(0));
      if (token !== speechToken) return;
      const src = playbackCtx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(playbackCtx.destination);
      currentSource = src;
      await new Promise((resolve, reject) => {
        src.onended = () => resolve();
        src.onerror = () => reject(new Error("playback failed"));
        src.start(0);
      });
    } catch (e) {
      if (window.speechSynthesis && clean) {
        const u = new SpeechSynthesisUtterance(clean);
        window.speechSynthesis.speak(u);
        await new Promise((r) => {
          u.onend = () => r();
          u.onerror = () => r();
        });
      } else if (manageUi) {
        deps.addMsg("system", "TTS failed: " + (e.message || e));
      }
    } finally {
      if (manageUi && conversationMode) {
        setPhase("STANDBY");
        scheduleListeningRestart();
      }
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
    const tokRes = await fetch(deps.apiUrl("/api/jarvis/deepgram/token"));
    const tok = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok) throw new Error(tok.error || "STT token failed");
    const listenPath = tok.url || "/api/jarvis/deepgram/listen";
    const wsBase = deps.apiUrl(listenPath);
    const wsUrl = wsBase.replace(/^http/, "ws");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      let settled = false;
      ws.onopen = () => {
        reconnectAttempt = 0;
        if (!settled) {
          settled = true;
          resolve(ws);
        }
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("Deepgram socket error"));
        }
      };
      ws.onclose = () => {
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

    if (fromTap) await unlockAudio();

    setPhase("LISTENING");
    listening = true;
    utteranceSegments = [];
    utteranceInterim = "";

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    captureCtx = new Ctx();
    const input = captureCtx.createMediaStreamSource(mediaStream);
    analyser = captureCtx.createAnalyser();
    analyser.fftSize = 512;
    input.connect(analyser);

    processor = captureCtx.createScriptProcessor(4096, 1, 1);
    input.connect(processor);
    processor.connect(captureCtx.destination);

    const inRate = captureCtx.sampleRate;
    const rmsBuf = new Float32Array(analyser.fftSize);

    processor.onaudioprocess = (e) => {
      if (!listening || !dgSocket || dgSocket.readyState !== WebSocket.OPEN) return;
      const ch = e.inputBuffer.getChannelData(0);
      const pcm = resampleTo16k(ch, inRate);
      dgSocket.send(pcm);
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

    await openDeepgramSocket();
  }

  function scheduleListeningRestart() {
    if (!conversationMode) return;
    setTimeout(() => {
      if (conversationMode && phase === "STANDBY") void startListening(false);
    }, 300);
  }

  async function finishTranscript(text) {
    if (!text.trim()) return;
    if (phase === "PROCESSING" || phase === "RESPONDING") return;
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
      deps.addMsg("system", "Error: " + (e.message || e));
      setPhase("STANDBY");
      if (conversationMode) scheduleListeningRestart();
    }
  }

  async function toggleConversation() {
    if (!deps) return;
    if (conversationMode) {
      conversationMode = false;
      haltPlayback();
      cleanupListening();
      setPhase("STANDBY");
      deps.setMicActive(false);
      return;
    }
    conversationMode = true;
    deps.setMicActive(true);
    await startListening(true);
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
      void unlockAudio().then(() => scheduleListeningRestart());
    }
  });
})();
