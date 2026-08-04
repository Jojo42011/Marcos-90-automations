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

  // Turn-taking constants ported from livekit/agents InterruptionOptions
  // (via the conversational playbook §5). The behaviors, not the framework.
  const BARGE_IN_GRACE_MS = 1000;          // ignore the first second after Harvey starts speaking (his own onset, echo)
  const BARGE_IN_MIN_WORDS = 3;            // a real interruption, not an echo blip or a listening noise
  const BARGE_IN_SUSTAIN_FRAMES = 4;       // ×~128ms mic frames ≈ 500ms of sustained speech before RMS counts as a barge-in
  const FALSE_INTERRUPTION_TIMEOUT_MS = 2000; // no committed turn within 2s → it wasn't an interruption, resume
  const POST_SPEECH_COOLDOWN_MS = 1200;    // STT commits lag the audio: echo/backchannel guards apply this long after playback
  const BRIDGE_PHRASE_AFTER_MS = 2500;     // nothing spoken this long after a commit → one short bridge, never dead air
  // Listening noises — never interrupts, and never turns of their own right after Harvey speaks.
  const BACKCHANNEL_RE = /^(?:mm+|mhm+|uh[- ]?huh|yeah|yep|ok(?:ay)?|right|sure|got it|i see|nice|cool|gotcha|alright|hmm+|ah+|oh+)[.!,]?$/i;
  // An explicit stop discards the parked audio instead of resuming it.
  const STOP_COMMAND_RE = /^(?:stop|stop it|stop talking|shut up|quiet|be quiet|never ?mind|cancel|forget it)[.!,]?$/i;

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
  // STT WebSocket lifecycle: created ONCE per session via initSttWebSocket().
  // pause/resumeMicCapture only toggle micSending on this same socket — the
  // socket is never recreated on a barge-in or mic pause. It is only re-created
  // by a controlled reconnect if it drops unexpectedly while the session is
  // still active (which must NOT re-run the greeting).
  let sttConnected = false;
  let captureStarted = false; // mic AudioContext/ScriptProcessor set up once
  let sttReconnectTimer = null;
  let sttHealthTimer = null;
  let sttRetries = 0;

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

  // Turn-taking state (see the constants above).
  let bargeGraceUntil = 0;        // set when playback actually STARTS, not when it's requested
  let rmsRunFrames = 0;           // consecutive mic frames above the RMS threshold
  let lastPlaybackEndedAt = 0;    // drives the post-speech cooldown at commit time
  let recentSpokenText = "";      // what Harvey just said, for the self-echo compare
  let parked = null;              // { timer } while audio is parked pending a real turn
  let bridgeTimer = null;

  function normalizeWords(t) {
    return t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  }

  // Everything Harvey speaks passes through here so a transcript that is just
  // his own voice leaking back in can be recognized and dropped.
  function noteSpokenText(text) {
    const norm = normalizeWords(text || "");
    if (!norm) return;
    recentSpokenText = (recentSpokenText + " " + norm).slice(-800);
  }

  function isEchoOfHarvey(text) {
    const norm = normalizeWords(text);
    if (!norm || !recentSpokenText) return false;
    if (recentSpokenText.includes(norm)) return true;
    const words = norm.split(" ");
    if (words.length < 3) return false;
    const hits = words.filter((w) => recentSpokenText.includes(w)).length;
    return hits / words.length >= 0.8;
  }

  function clearBridgeTimer() {
    if (bridgeTimer) {
      clearTimeout(bridgeTimer);
      bridgeTimer = null;
    }
  }

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
    // Post-speech cooldown: STT commits seconds after the audio, so Harvey's
    // own tail (echo) and Marco's listening noises land right AFTER playback
    // ends — exactly when the mic re-opens. Guard at COMMIT time, both kinds.
    if (Date.now() - lastPlaybackEndedAt < POST_SPEECH_COOLDOWN_MS) {
      if (BACKCHANNEL_RE.test(t)) {
        console.log("[VAD] Dropped backchannel in post-speech cooldown:", t);
        return false;
      }
      if (isEchoOfHarvey(t)) {
        console.log("[VAD] Dropped self-echo in post-speech cooldown:", t.slice(0, 60));
        return false;
      }
    }
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

  // ── Voice-driven shell navigation ──────────────────────────────────────────
  // Detect a navigation command in a committed transcript and switch the shell
  // tab instantly — no brain round-trip. Self-contained (duplicated from the
  // shell contract, small enough per spec). Tab keys match public/shell.html TABS.
  const NAV_INTENTS = [
    { patterns: [/\b(crm|leads?|contacts?|pipeline)\b/i], tab: "crm", label: "CRM" },
    { patterns: [/\b(content|tiktok|videos?|social|posts?)\b/i], tab: "content", label: "Content Manager" },
    { patterns: [/\b(email|drip|templates?|campaigns?)\b/i], tab: "email", label: "Email Marketing" },
    { patterns: [/\b(finance|gci|commissions?|expenses?|revenue)\b/i], tab: "finance", label: "Finance" },
    { patterns: [/\b(report|reporting|digest|kpi|analytics)\b/i], tab: "reporting", label: "Reporting" },
    { patterns: [/\b(nurture|scoring|hot leads?|cold leads?|warm leads?)\b/i], tab: "leads", label: "Lead Nurture" },
    { patterns: [/\b(voice( clone)?|voiceover|scripts?|voxcpm)\b/i], tab: "voice", label: "Voice Clone" },
    { patterns: [/\b(tasks?|task center|to.?do)\b/i], tab: "tasks", label: "Tasks" },
    { patterns: [/\b(harvey|home|back|assistant)\b/i], tab: "harvey", label: "Harvey" },
  ];
  // A navigation command must pair a nav phrase with a target above, so ordinary
  // conversation that merely mentions "email" or "leads" is not hijacked.
  const NAV_PHRASES = /\b(take me|go to|open|show me|navigate|switch to|bring up|launch|pull up)\b/i;

  function detectNavigationIntent(transcript) {
    if (!transcript || !NAV_PHRASES.test(transcript)) return null;
    for (const intent of NAV_INTENTS) {
      if (intent.patterns.some((p) => p.test(transcript))) return intent;
    }
    return null;
  }

  // Switch the shell tab, covering all three runtime cases: the ShellNav bridge
  // (voice-nav-bridge inlined in jarvis.html), an embedded iframe (postMessage to
  // the parent shell), or standalone (hard navigate). Content → /social (there is
  // no /content route).
  function navigateShell(tab) {
    // Embedded in the shell (the normal case — Harvey is the home tab): tell the
    // parent shell to switch tabs via the bridge (or a direct postMessage).
    if (window.parent !== window) {
      if (typeof ShellNav !== "undefined" && ShellNav && typeof ShellNav.go === "function") {
        ShellNav.go(tab);
      } else {
        window.parent.postMessage({ type: "app-navigate", tab: tab }, "*");
      }
      return;
    }
    // Standalone (page opened directly, no shell): hard-navigate to the route.
    const routes = {
      crm: "/dashboard", content: "/social", email: "/email-marketing",
      finance: "/finance", reporting: "/reporting", leads: "/lead-nurture",
      voice: "/voice-clone", tasks: "/tasks", harvey: "/jarvis",
    };
    if (routes[tab]) window.location.href = routes[tab];
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

    // TODO(separate task): migrate to AudioWorkletNode — createScriptProcessor is
    // deprecated (console warning on mic start). Not done here: it needs a separate
    // worklet module file + main-thread message passing for the WS send, plus
    // re-homing the downsample and RMS barge-in detection off this callback, which
    // risks the barge-in path. Functional today; the warning is cosmetic.
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
      if (!isVoicePlaybackActive() || bargeInCooldown) {
        rmsRunFrames = 0;
        return;
      }
      // Start-of-speech grace: Harvey's own onset (and its room echo) must not
      // count as an interruption in the first second of his turn.
      if (Date.now() < bargeGraceUntil) return;
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length) * 100;
      if (rms > BARGE_IN_RMS_THRESHOLD) {
        // min_duration: one loud frame is a cough or a door; ~500ms of
        // sustained level is a person actually talking over Harvey.
        rmsRunFrames++;
        if (rmsRunFrames >= BARGE_IN_SUSTAIN_FRAMES) {
          rmsRunFrames = 0;
          triggerBargeIn();
        }
      } else {
        rmsRunFrames = 0;
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
        // While parked, an EndOfTurn is the verdict on whether the barge-in
        // was real — it must not go through the normal commit gate (brainBusy
        // is still true for the reply being spoken).
        if (parked) {
          handleParkedUtterance((finalText || "").trim());
          return;
        }
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
    console.log("[aethon-voice] commit:", text);

    // Navigation intent → switch the shell tab instantly and skip the brain
    // round-trip. Harvey speaks a short confirmation (mic pause/resume handled
    // by speakText). brainBusy stays false so the next command still works.
    const navIntent = detectNavigationIntent(text);
    if (navIntent) {
      console.log("[Harvey] Navigation intent detected → " + navIntent.tab);
      navigateShell(navIntent.tab);
      await speakText("Opening " + navIntent.label + " now.");
      return;
    }

    brainBusy = true;
    sessionTranscript.push({ role: "user", text, ts: Date.now() });
    setHarveyStatus("PROCESSING");
    pauseMicCapture();

    // Bridge phrase: if nothing has been spoken this long after the commit
    // (slow tools, cold model), one short bridge — a tool round-trip must
    // never read as dead air. Cancelled the moment real speech starts.
    clearBridgeTimer();
    bridgeTimer = setTimeout(() => {
      bridgeTimer = null;
      if (brainBusy && !isVoicePlaybackActive()) {
        console.log("[Harvey] Brain is slow — bridge phrase");
        noteSpokenText("One sec.");
        void window.HarveyStreamingTts?.speak?.("One sec.");
      }
    }, BRIDGE_PHRASE_AFTER_MS);

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
              clearBridgeTimer();
              pauseMicForHarveyResponse();
              noteSpokenText(data.text);
              speakPromise = window.HarveyStreamingTts.speak(data.text, {
                streamingOpen: true,
                onStart: () => {
                  bargeGraceUntil = Date.now() + BARGE_IN_GRACE_MS;
                },
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
          // Harvey can hand long work to a background job by voice too — follow
          // it, or the operator is left with no idea whether it finished.
          if (window.HarveyJobWatch) window.HarveyJobWatch.watchReply(fullSpeech);
          if (firstChunkStarted) {
            noteSpokenText(fullSpeech);
            window.HarveyStreamingTts.appendRemainingText(fullSpeech, {
              onEnd: () => {
                lastPlaybackEndedAt = Date.now();
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
          if (window.HarveyJobWatch) window.HarveyJobWatch.watchReply(speech);
          await speakText(speech);
        }
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      showVoiceError(raw);
      setHarveyStatus("ERROR");
      // Say the failure in Harvey's own voice (playbook §7.9): to someone
      // wearing headphones, silence is indistinguishable from being ignored.
      const spokenLine = /429|rate.?limit|overloaded/i.test(raw)
        ? "I just hit my rate limit. Give me ten seconds and ask that again."
        : /network|fetch|HTTP 5|timeout|timed out/i.test(raw)
          ? "I lost the connection for a second there. Say that again."
          : "Something broke on my end. Give it another go.";
      try {
        await speakText(spokenLine);
      } catch (_) {}
    } finally {
      clearBridgeTimer();
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
      noteSpokenText(fullText);
      await window.HarveyStreamingTts.speak(fullText, {
        onStart: () => {
          bargeGraceUntil = Date.now() + BARGE_IN_GRACE_MS;
        },
        onEnd: () => {
          lastPlaybackEndedAt = Date.now();
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

  // Create the STT WebSocket exactly once (or re-create it on an unexpected drop
  // while a session is still active). This is the ONLY place sttWs is created —
  // barge-in and mic pause/resume never touch the socket, so sttWs.onopen fires
  // once per page load under normal conversation. A reconnect here rebuilds ONLY
  // the socket; it never re-runs the activation greeting.
  function initSttWebSocket() {
    if (sttWs && (sttWs.readyState === WebSocket.OPEN || sttWs.readyState === WebSocket.CONNECTING)) {
      console.log("[STT] WebSocket already open/connecting — skipping init");
      return;
    }
    const u = new URL("/api/jarvis/elevenlabs/listen", window.location.origin);
    const t = getToken();
    if (t) u.searchParams.set("token", t);
    const wsUrl = u.toString().replace(/^http/, "ws");

    console.log("[STT] Creating ElevenLabs STT WebSocket");
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

    sttWs.onclose = (evt) => {
      sttConnected = false;
      sessionReady = false;
      listening = false;
      console.log("[STT] WebSocket closed — code:", evt && evt.code);
      // Reconnect ONLY if the session is still active (i.e. not an intentional
      // stopAethonVoice, which sets voiceActive=false before closing). This
      // rebuilds just the socket — no greeting, no new mic pipeline.
      if (voiceActive) {
        if (sttReconnectTimer) clearTimeout(sttReconnectTimer);
        // Backoff, capped. A tight 2s retry against a server that is down (or
        // an API key that has expired) just hammers it; unbounded backoff means
        // Harvey never comes back.
        const delay = Math.min(2000 * Math.pow(1.6, Math.min(sttRetries, 5)), 15000);
        sttRetries++;
        sttReconnectTimer = setTimeout(() => {
          sttReconnectTimer = null;
          if (voiceActive) {
            listening = true;
            console.log("[STT] Reconnecting STT WebSocket (session still active)");
            initSttWebSocket();
          }
        }, delay);
      }
    };

    sttWs.onopen = async () => {
      sttConnected = true;
      listening = true;
      sttRetries = 0;
      console.log("[STT] WebSocket connected");
      // Set up the mic pipeline once; on a reconnect it persists (don't rebuild
      // the AudioContext — that would churn the mic and drop barge-in monitoring).
      if (!captureStarted) {
        captureStarted = true;
        await startCapture();
      }
      startSttHealthWatch();
    };
  }

  /**
   * Keep listening alive when the tab isn't the one being looked at.
   *
   * The reconnect above is a setTimeout, and browsers throttle timers in a
   * HIDDEN tab to roughly one per minute. That is precisely the situation
   * Harvey creates for himself — he opens a site, the operator looks at it,
   * the Harvey tab goes to the background — so a dropped socket that should
   * have recovered in two seconds could sit dead for a minute or more. From
   * the outside that is "he stops listening after a while".
   *
   * Two defences, because neither alone is enough:
   *   1. A periodic health check that reconnects a socket found closed. Still
   *      a timer, so still throttled — but a throttled check every ~60s beats
   *      a reconnect that was never scheduled at all.
   *   2. An immediate check the moment the tab becomes visible again, plus one
   *      on window focus and on the network coming back. These are EVENTS, not
   *      timers, so throttling doesn't apply — this is what makes coming back
   *      to Harvey feel instant instead of dead for a minute.
   *
   * The AudioContext gets resumed here too: browsers may suspend it while
   * hidden, and a suspended context delivers silence rather than an error, so
   * the socket looks perfectly healthy while nothing is being heard.
   */
  function checkSttHealth(reason) {
    if (!voiceActive) return;
    try {
      if (captureCtx && captureCtx.state === "suspended") {
        captureCtx.resume().catch(() => {});
        console.log("[STT] Resumed suspended mic AudioContext (" + reason + ")");
      }
    } catch (_) {}
    const dead = !sttWs || sttWs.readyState === WebSocket.CLOSED || sttWs.readyState === WebSocket.CLOSING;
    if (dead) {
      console.log("[STT] Health check found a dead socket (" + reason + ") — reconnecting now");
      if (sttReconnectTimer) { clearTimeout(sttReconnectTimer); sttReconnectTimer = null; }
      sttRetries = 0;   // a user-visible return deserves a fast first retry
      initSttWebSocket();
    }
  }

  function startSttHealthWatch() {
    if (sttHealthTimer) return;
    sttHealthTimer = setInterval(() => checkSttHealth("interval"), 15000);
  }

  function stopSttHealthWatch() {
    if (sttHealthTimer) { clearInterval(sttHealthTimer); sttHealthTimer = null; }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkSttHealth("tab visible");
  });
  window.addEventListener("focus", () => checkSttHealth("window focus"));
  window.addEventListener("online", () => checkSttHealth("network back"));

  // Only one Harvey tab may run voice at a time. When a session starts here we
  // tell every other tab to stand down; a tab hearing that while live stops its
  // own session, so two open Harveys can't fight over the mic.
  const VOICE_TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let voiceChannel = null;
  try {
    voiceChannel = new BroadcastChannel("harvey-voice");
    voiceChannel.onmessage = (ev) => {
      const msg = ev && ev.data;
      if (msg && msg.type === "voice-started" && msg.tab !== VOICE_TAB_ID && voiceActive) {
        stopAethonVoice();
        document.getElementById("harvey-mic-btn")?.classList.remove("active");
        showVoiceError("Voice moved to another Harvey tab — this one went quiet.");
      }
    };
  } catch (_) {}

  async function startAethonVoice() {
    try { voiceChannel?.postMessage({ type: "voice-started", tab: VOICE_TAB_ID }); } catch (_) {}
    if (typeof window.onHarveyVoiceSessionStart === "function") {
      window.onHarveyVoiceSessionStart();
    }
    clearVoiceError();
    setHarveyStatus("CONNECTING");
    voiceActive = true;
    sessionStartTime = new Date().toISOString();
    listening = true;
    sessionReady = false;
    captureStarted = false;
    if (sttReconnectTimer) {
      clearTimeout(sttReconnectTimer);
      sttReconnectTimer = null;
    }

    initSttWebSocket();

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
    voiceActive = false; // set BEFORE closing so onclose does not reconnect
    listening = false;
    if (sttReconnectTimer) {
      clearTimeout(sttReconnectTimer);
      sttReconnectTimer = null;
    }
    // Otherwise the health check keeps reviving a session the user just ended.
    stopSttHealthWatch();
    sttRetries = 0;
    clearBridgeTimer();
    if (parked) {
      clearTimeout(parked.timer);
      parked = null;
    }
    rmsRunFrames = 0;
    recentSpokenText = "";
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
      sttWs.close(1000, "session ended"); // clean close — no reconnect
      sttWs = null;
    }
    sttConnected = false;
    captureStarted = false;
    stopMicStream();
    void flushTranscriptToMemory();
    setHarveyStatus("STANDBY");
    if (typeof window.onHarveyVoiceSessionEnd === "function") {
      window.onHarveyVoiceSessionEnd();
    }
  }

  function interruptHarvey() {
    console.log("[Harvey] Barge-in — stopping immediately");
    lastPlaybackEndedAt = Date.now();
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

  /* ── False-interruption resume (livekit/agents behavior) ──────────────────
   * A barge-in PARKS the unplayed audio instead of destroying it, and opens
   * the mic. If no real turn follows within FALSE_INTERRUPTION_TIMEOUT_MS —
   * or what follows is a backchannel, a self-echo, or too short to be a turn —
   * it wasn't an interruption: the parked sentence resumes. An explicit
   * "stop" still discards; a genuine new turn discards the remainder so it
   * can never resurface, and is then committed to the brain. */
  function parkHarvey() {
    const couldPark = window.HarveyStreamingTts?.pause?.();
    if (!couldPark) {
      // Legacy queue path (no streaming session) can't park — hard interrupt.
      interruptHarvey();
      return;
    }
    console.log("[Harvey] Possible barge-in — audio parked, listening for a real turn");
    resumeMicCapture();
    setHarveyStatus("LISTENING");
    parked = {
      timer: setTimeout(
        () => resumeFromFalseInterruption("no turn followed"),
        FALSE_INTERRUPTION_TIMEOUT_MS,
      ),
    };
  }

  function resumeFromFalseInterruption(reason) {
    if (!parked) return;
    clearTimeout(parked.timer);
    parked = null;
    console.log("[Harvey] False interruption (" + reason + ") — resuming parked audio");
    pauseMicCapture();
    setHarveyStatus("RESPONDING");
    bargeGraceUntil = Date.now() + BARGE_IN_GRACE_MS;
    window.HarveyStreamingTts?.resume?.();
  }

  function handleParkedUtterance(text) {
    if (!parked) return;
    if (!text || BACKCHANNEL_RE.test(text)) {
      resumeFromFalseInterruption("backchannel");
      return;
    }
    if (STOP_COMMAND_RE.test(text)) {
      clearTimeout(parked.timer);
      parked = null;
      console.log("[Harvey] Explicit stop — discarding parked audio");
      interruptHarvey();
      return;
    }
    if (isEchoOfHarvey(text)) {
      resumeFromFalseInterruption("self-echo");
      return;
    }
    if (wordCount(text) < BARGE_IN_MIN_WORDS) {
      resumeFromFalseInterruption("too short to be a turn");
      return;
    }
    // A genuine new turn: kill the parked remainder for good and hand the
    // utterance to the brain once the abandoned reply's await unwinds.
    clearTimeout(parked.timer);
    parked = null;
    console.log("[Harvey] Real interruption — discarding parked audio, committing:", text.slice(0, 60));
    interruptHarvey();
    const started = Date.now();
    const wait = setInterval(() => {
      if (!brainBusy) {
        clearInterval(wait);
        void commitTranscript(text);
      } else if (Date.now() - started > 4000) {
        clearInterval(wait);
        console.warn("[Harvey] Brain never released after interruption — dropping:", text.slice(0, 60));
      }
    }, 80);
  }

  function triggerBargeIn() {
    if (bargeInCooldown || parked) return;
    bargeInCooldown = true;
    setTimeout(() => {
      bargeInCooldown = false;
    }, 300);
    parkHarvey();
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
