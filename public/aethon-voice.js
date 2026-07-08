/**
 * Aethon Intelligence voice — ElevenLabs Scribe v2 Realtime STT + Claude + Gemini TTS
 * (STT flows through the server proxy at /api/jarvis/elevenlabs/listen, which
 *  translates ElevenLabs messages into this client's turn contract — so the VAD
 *  and barge-in logic below are STT-vendor-agnostic and unchanged.)
 */
(function () {
  // Barge-in sensitivity. RMS computed on Float32 mic input × 100 (0–100 scale).
  // lower = more sensitive. 2-3 = normal voice, 6-8 = loud voice.
  const BARGE_IN_RMS_THRESHOLD = 3;

  let processor = null;
  let lpFilter = null;
  let captureCtx = null;
  let micStream = null;
  let sttWs = null;
  let sessionReady = false;
  let listening = false;
  let micSending = true;
  let voiceActive = false;
  let bargeInCooldown = false;

  let playCtx = null;
  let ttsQueue = [];
  let isPlaying = false;
  let currentSource = null;

  let sessionTranscript = [];
  let sessionStartTime = null;
  let brainBusy = false;
  let currentTurnIndex = -1;
  let latestTurnTranscript = "";
  let pendingCommitTimer = null;
  let micCaptureActive = false;

  function voiceSessionId() {
    const stored = sessionStorage.getItem("harvey_session_id");
    if (stored) return stored;
    const id = "harvey-voice-" + Date.now();
    sessionStorage.setItem("harvey_session_id", id);
    return id;
  }

  function wordCount(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  function shouldCommitTranscript(text, event) {
    const t = text.trim();
    if (!t) return false;
    if (!isMicCaptureActive()) return false;
    if (brainBusy || isVoicePlaybackActive()) return false;
    // Only finalize on high-confidence end of turn — eager fires too early on fragments.
    if (event !== "EndOfTurn") return false;
    if (wordCount(t) < 2 && t.length < 12) return false;
    return true;
  }

  function scheduleCommit(text, event) {
    if (!shouldCommitTranscript(text, event)) return;
    if (pendingCommitTimer) clearTimeout(pendingCommitTimer);
    pendingCommitTimer = setTimeout(() => {
      pendingCommitTimer = null;
      if (shouldCommitTranscript(text, event)) {
        void commitTranscript(text.trim());
      }
    }, 120);
  }

  function getToken() {
    return new URLSearchParams(window.location.search).get("token") || "";
  }

  function apiUrl(path) {
    const u = new URL(path, window.location.origin);
    const t = getToken();
    if (t) u.searchParams.set("token", t);
    return u.toString();
  }

  function authHeaders() {
    const t = getToken();
    return {
      "Content-Type": "application/json",
      Authorization: t ? `Bearer ${t}` : "",
    };
  }

  window.isGeminiLiveActive = function () {
    return voiceActive;
  };

  function setHarveyStatus(status) {
    const statusMessages = {
      CONNECTING: "🔄 Connecting STT...",
      LISTENING: "🎤 Listening...",
      RESPONDING: "🔊 Harvey speaking...",
      PROCESSING: "⚙️ Thinking...",
      STANDBY: "⏸ Standby",
      ERROR: "❌ Error — check console",
    };
    const el = document.getElementById("harvey-voice-status");
    if (el) el.textContent = statusMessages[status] || status;
    if (typeof setStatus === "function") {
      const on =
        status === "LISTENING" ||
        status === "RESPONDING" ||
        status === "CONNECTING" ||
        status === "PROCESSING";
      setStatus(status === "STANDBY" ? "STANDBY" : status, on);
    }
  }

  function showVoiceError(msg) {
    const el = document.getElementById("harvey-voice-error");
    if (el) {
      el.textContent = "⚠️ " + msg;
      el.style.display = "block";
    }
    console.error("[aethon-voice]", msg);
  }

  function clearVoiceError() {
    const el = document.getElementById("harvey-voice-error");
    if (el) {
      el.textContent = "";
      el.style.display = "none";
    }
  }

  function downsampleBuffer(buffer, inputRate, outputRate) {
    if (outputRate === inputRate) return buffer;
    const ratio = inputRate / outputRate;
    const newLen = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = buffer[idx] || 0;
      const b = buffer[Math.min(idx + 1, buffer.length - 1)] || 0;
      result[i] = a + frac * (b - a);
    }
    return result;
  }

  function floatTo16BitPCM(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function stopCapture() {
    if (processor) {
      try {
        processor.disconnect();
        processor.onaudioprocess = null;
      } catch (_) {}
      processor = null;
    }
    if (lpFilter) {
      try {
        lpFilter.disconnect();
      } catch (_) {}
      lpFilter = null;
    }
    if (captureCtx) {
      try {
        captureCtx.close();
      } catch (_) {}
      captureCtx = null;
    }
  }

  function pauseMicCapture() {
    // Keep the audio node connected so the RMS monitor can still detect barge-in
    // while Harvey speaks. micSending=false stops STT transcription (so Harvey
    // is never transcribed), but the processor keeps running for local RMS analysis.
    micCaptureActive = false;
    micSending = false;
    console.log("[Mic] Capture PAUSED — Harvey speaking");
  }

  function resumeMicCapture() {
    if (!voiceActive || !listening) return;
    micCaptureActive = true;
    micSending = true;
    console.log("[Mic] Capture RESUMED — ready for Marco");
  }

  function isMicCaptureActive() {
    return micCaptureActive;
  }

  async function startCapture() {
    stopCapture();
    if (!micStream) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    }

    captureCtx = new AudioContext({ sampleRate: 16000 });
    if (captureCtx.state === "suspended") await captureCtx.resume();

    const source = captureCtx.createMediaStreamSource(micStream);
    const inputRate = captureCtx.sampleRate;

    lpFilter = captureCtx.createBiquadFilter();
    lpFilter.type = "lowpass";
    lpFilter.frequency.value = 7500;
    lpFilter.Q.value = 0.707;

    processor = captureCtx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (e) => {
      if (!listening || !sessionReady) return;
      const input = e.inputBuffer.getChannelData(0);

      if (micSending) {
        if (!sttWs || sttWs.readyState !== WebSocket.OPEN) return;
        const down = downsampleBuffer(input, inputRate, 16000);
        const pcm = floatTo16BitPCM(down);
        sttWs.send(pcm.buffer);
        return;
      }

      // Mic muted for transcription (Harvey speaking) — watch for barge-in via local RMS.
      if (!isVoicePlaybackActive() || bargeInCooldown) return;
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length) * 100;
      if (rms > BARGE_IN_RMS_THRESHOLD) {
        triggerBargeIn();
      }
    };

    source.connect(lpFilter);
    lpFilter.connect(processor);
    processor.connect(captureCtx.destination);
    micSending = true;
    micCaptureActive = true;
  }

  function stopMicStream() {
    stopCapture();
    micCaptureActive = false;
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
  }

  function handleSttMessage(raw) {
    let msg;
    try {
      msg = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return;
    }

    if (msg.type === "ready" || msg.type === "Connected") {
      sessionReady = true;
      setHarveyStatus("LISTENING");
      return;
    }

    if (msg.type === "TurnInfo") {
      const transcript = (msg.transcript || "").trim();
      const turnIndex = typeof msg.turn_index === "number" ? msg.turn_index : 0;
      const event = msg.event || "";

      if (event === "StartOfTurn") {
        if (!isMicCaptureActive()) {
          console.log("[VAD] StartOfTurn ignored — mic is paused (Harvey speaking or generating)");
          return;
        }
        if (!isVoicePlaybackActive()) {
          return;
        }
        console.log("[Harvey] Barge-in detected — Marco interrupted");
        triggerBargeIn();
        return;
      }

      if (event === "StartOfTurn" || event === "Update") {
        if (turnIndex !== currentTurnIndex) {
          currentTurnIndex = turnIndex;
          latestTurnTranscript = transcript;
        } else if (transcript) {
          latestTurnTranscript = transcript;
        }
        return;
      }

      if (event === "TurnResumed") {
        if (pendingCommitTimer) {
          clearTimeout(pendingCommitTimer);
          pendingCommitTimer = null;
        }
        if (transcript) latestTurnTranscript = transcript;
        return;
      }

      if (event === "EagerEndOfTurn") {
        if (transcript) latestTurnTranscript = transcript;
        return;
      }

      if (event === "EndOfTurn") {
        const finalText = transcript || latestTurnTranscript;
        latestTurnTranscript = finalText;
        scheduleCommit(finalText, event);
      }
      return;
    }

    // Legacy Nova / metadata frames — ignore without blocking STT.
    if (msg.type === "Results" || msg.type === "Metadata") return;
  }

  function pauseMicForHarveyResponse() {
    pauseMicCapture();
    setHarveyStatus("RESPONDING");
  }

  async function commitTranscript(text) {
    if (!text || brainBusy) return;
    brainBusy = true;
    console.log("[aethon-voice] commit:", text);
    sessionTranscript.push({ role: "user", text, ts: Date.now() });
    setHarveyStatus("PROCESSING");
    pauseMicCapture();

    try {
      const res = await fetch(apiUrl("/api/jarvis/voice/command"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ message: text, sessionId: voiceSessionId(), stream: true }),
      });
      if (!res.ok) throw new Error("Brain HTTP " + res.status);

      const contentType = res.headers.get("Content-Type") || "";
      if (contentType.includes("text/event-stream") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let firstChunkStarted = false;
        let fullSpeech = "";
        let speakPromise = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            const data = JSON.parse(line.slice(6));
            if (data.type === "error") throw new Error(data.error || "Brain stream error");
            if (data.type === "speech_chunk" && !firstChunkStarted && data.text) {
              firstChunkStarted = true;
              console.log("[Harvey] First sentence received from brain — starting TTS immediately");
              pauseMicForHarveyResponse();
              speakPromise = window.HarveyStreamingTts.speak(data.text, {
                streamingOpen: true,
              });
            }
            if (data.type === "speech_complete") {
              fullSpeech = data.speech || "";
              if (data.sessionId) {
                sessionStorage.setItem("harvey_session_id", data.sessionId);
              }
            }
          }
        }

        if (fullSpeech) {
          sessionTranscript.push({ role: "assistant", text: fullSpeech, ts: Date.now() });
          if (typeof addMsg === "function") addMsg("user", text);
          if (typeof addMsg === "function") addMsg("ai", fullSpeech);
          if (typeof window.detectMetricsTrigger === "function") window.detectMetricsTrigger(fullSpeech);
          if (firstChunkStarted) {
            window.HarveyStreamingTts.appendRemainingText(fullSpeech, {
              onEnd: () => {
                resumeMicCapture();
                setHarveyStatus("LISTENING");
                console.log("[Harvey] Mic re-enabled — ready for next message");
              },
            });
            if (speakPromise) await speakPromise;
          } else {
            await speakText(fullSpeech);
          }
        }
      } else {
        const data = await res.json();
        const speech = data.speech || "";
        if (speech) {
          sessionTranscript.push({ role: "assistant", text: speech, ts: Date.now() });
          if (typeof addMsg === "function") addMsg("user", text);
          if (typeof addMsg === "function") addMsg("ai", speech);
          if (typeof window.detectMetricsTrigger === "function") window.detectMetricsTrigger(speech);
          await speakText(speech);
        }
      }
    } catch (err) {
      showVoiceError(err instanceof Error ? err.message : String(err));
      setHarveyStatus("ERROR");
    } finally {
      brainBusy = false;
    }

    // Fallback resume only if mic still paused after an error (onEnd did not run).
    if (!isVoicePlaybackActive() && !isMicCaptureActive() && voiceActive) {
      resumeMicCapture();
      setHarveyStatus("LISTENING");
    }
  }

  function stripForSpeech(text) {
    return text
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/^#+\s*/gm, "")
      .replace(/^[-•]\s+/gm, "")
      .replace(/\n{2,}/g, ". ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isVoicePlaybackActive() {
    if (window.HarveyStreamingTts?.isActive?.()) return true;
    return isPlaying;
  }

  async function speakText(fullText) {
    if (window.HarveyStreamingTts) {
      pauseMicForHarveyResponse();
      await window.HarveyStreamingTts.speak(fullText, {
        onEnd: () => {
          resumeMicCapture();
          setHarveyStatus("LISTENING");
          console.log("[Harvey] Mic re-enabled — ready for next message");
        },
      });
      return;
    }
    const clean = stripForSpeech(fullText);
    if (!clean) return;
    ttsQueue.push(clean);
    if (!isPlaying) drainTtsQueue();
  }

  async function drainTtsQueue() {
    if (isPlaying) return;
    isPlaying = true;
    pauseMicCapture();
    setHarveyStatus("RESPONDING");

    while (ttsQueue.length > 0) {
      const text = ttsQueue.shift();
      if (!text) continue;
      try {
        const t0 = performance.now();
        const res = await fetch(apiUrl("/api/jarvis/voice"), {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ text: text.slice(0, 1200) }),
        });
        if (!res.ok) continue;
        const sampleRate = parseInt(res.headers.get("X-Sample-Rate") || "24000", 10);
        const buf = await res.arrayBuffer();
        console.log(
          "[aethon-voice] TTS",
          Math.round(performance.now() - t0),
          "ms,",
          sampleRate,
          "Hz,",
          buf.byteLength,
          "bytes",
        );
        await playPcm(buf, sampleRate);
      } catch (e) {
        console.error("[aethon-voice] TTS error:", e);
      }
    }

    isPlaying = false;
    resumeMicCapture();
    setHarveyStatus("LISTENING");
  }

  function unlockAudioFromUserGesture() {
    window.HarveyStreamingTts?.unlock?.();
    if (!playCtx) playCtx = new AudioContext();
    if (playCtx.state === "suspended") playCtx.resume();
  }

  function playPcm(buffer, sampleRate) {
    return new Promise((resolve) => {
      const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 24000;
      if (!playCtx || playCtx.sampleRate !== rate) {
        try {
          if (playCtx) playCtx.close();
        } catch (_) {}
        playCtx = new AudioContext({ sampleRate: rate });
      }
      if (playCtx.state === "suspended") playCtx.resume();

      const pcm = new Int16Array(buffer);
      const audioBuffer = playCtx.createBuffer(1, pcm.length, rate);
      const ch = audioBuffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;

      const source = playCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(playCtx.destination);
      currentSource = source;
      source.start(playCtx.currentTime);
      source.onended = () => {
        currentSource = null;
        resolve();
      };
    });
  }

  async function flushTranscriptToMemory() {
    if (sessionTranscript.length < 2) {
      sessionTranscript = [];
      return;
    }
    try {
      await fetch(apiUrl("/api/memory/extract-voice"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          sessionId: voiceSessionId(),
          transcript: sessionTranscript.map((t) => ({ role: t.role, text: t.text })),
          sessionStart: sessionStartTime,
          sessionEnd: new Date().toISOString(),
        }),
      });
    } catch (e) {
      console.error("[aethon-voice] memory flush failed:", e);
    }
    sessionTranscript = [];
    sessionStartTime = null;
  }

  async function startAethonVoice() {
    if (typeof window.onHarveyVoiceSessionStart === "function") {
      window.onHarveyVoiceSessionStart();
    }
    clearVoiceError();
    setHarveyStatus("CONNECTING");
    voiceActive = true;
    sessionStartTime = new Date().toISOString();
    listening = true;
    sessionReady = false;

    const u = new URL("/api/jarvis/elevenlabs/listen", window.location.origin);
    const t = getToken();
    if (t) u.searchParams.set("token", t);
    const wsUrl = u.toString().replace(/^http/, "ws");

    sttWs = new WebSocket(wsUrl);
    sttWs.binaryType = "arraybuffer";

    // Register message handler BEFORE onopen — Connected can arrive immediately.
    sttWs.onmessage = (ev) => {
      handleSttMessage(ev.data);
    };

    sttWs.onerror = () => {
      showVoiceError("STT WebSocket error — check ELEVENLABS_API_KEY");
      setHarveyStatus("ERROR");
    };

    sttWs.onclose = () => {
      listening = false;
      sessionReady = false;
    };

    sttWs.onopen = async () => {
      await startCapture();
    };

    try {
      const act = await fetch(apiUrl("/api/jarvis/activation"), { headers: authHeaders() });
      if (act.ok) {
        const { text } = await act.json();
        if (text) {
          const waitReady = () =>
            new Promise((resolve) => {
              if (sessionReady) return resolve();
              const t = setInterval(() => {
                if (sessionReady) {
                  clearInterval(t);
                  resolve();
                }
              }, 50);
              setTimeout(() => {
                clearInterval(t);
                sessionReady = true;
                resolve();
              }, 2000);
            });
          await waitReady();
          await speakText(text);
        }
      }
    } catch (_) {}
  }

  function stopAethonVoice() {
    voiceActive = false;
    listening = false;
    ttsQueue = [];
    window.HarveyStreamingTts?.stop?.();
    if (currentSource) {
      try {
        currentSource.stop();
      } catch (_) {}
      currentSource = null;
    }
    isPlaying = false;
    if (sttWs) {
      sttWs.close();
      sttWs = null;
    }
    stopMicStream();
    void flushTranscriptToMemory();
    setHarveyStatus("STANDBY");
    if (typeof window.onHarveyVoiceSessionEnd === "function") {
      window.onHarveyVoiceSessionEnd();
    }
  }

  function interruptHarvey() {
    console.log("[Harvey] Barge-in — stopping immediately");
    window.HarveyStreamingTts?.stop?.();
    ttsQueue = [];
    if (currentSource) {
      try {
        currentSource.stop(0);
      } catch (_) {}
      currentSource = null;
    }
    isPlaying = false;
    if (!isMicCaptureActive()) {
      resumeMicCapture();
      setHarveyStatus("LISTENING");
      console.log("[Mic] Capture RESUMED after barge-in");
    }
  }

  function triggerBargeIn() {
    if (bargeInCooldown) return;
    bargeInCooldown = true;
    setTimeout(() => {
      bargeInCooldown = false;
    }, 300);
    interruptHarvey();
  }

  window.interruptHarvey = interruptHarvey;
  window.unlockHarveyVoiceAudio = unlockAudioFromUserGesture;

  window.startHarveyVoiceSession = async function () {
    unlockAudioFromUserGesture();
    if (voiceActive) return;
    await startAethonVoice();
    document.getElementById("harvey-mic-btn")?.classList.add("active");
  };

  document.addEventListener("DOMContentLoaded", () => {
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const micBtn = document.getElementById("harvey-mic-btn");

    const startFlow = async () => {
      unlockAudioFromUserGesture();
      if (voiceActive) {
        stopAethonVoice();
        micBtn?.classList.remove("active");
      } else {
        await startAethonVoice();
        micBtn?.classList.add("active");
      }
    };

    if (micBtn) {
      micBtn.addEventListener("click", () => {
        if (isMobile) unlockAudioFromUserGesture();
        startFlow().catch((e) => showVoiceError(e.message || String(e)));
      });
    }
  });
})();
