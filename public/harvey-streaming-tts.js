/* Harvey streaming TTS — shared copy of the module defined inline in jarvis.html,
   extracted verbatim so the new /operator screen can reuse Harvey's exact voice.
   Only external dependency is apiUrl(), provided here self-contained. */
(function(){
  var token = new URLSearchParams(window.location.search).get("token") || "";
  function apiUrl(path){ var u = new URL(path, window.location.origin); if(token) u.searchParams.set("token", token); return u.toString(); }
    window.HarveyStreamingTts = (function () {
      let ttsIsPlaying = false;
      let ttsCurrentSource = null;
      let ttsAudioCtx = null;
      let ttsSampleRate = 24000;
      let speakResolve = null;
      let speakOnEnd = null;

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

      /** ~1–2s of speech — keeps first Gemini TTS call fast (~2s vs 7s+). */
      const FIRST_CHUNK_MAX = 85;
      /** ~2–4s per subsequent chunk — gapless chain, smaller API payloads. */
      const CHUNK_MAX = 130;

      function splitToMaxLen(segment, maxLen) {
        const t = segment.trim();
        if (!t) return [];
        if (t.length <= maxLen) return [t];

        const pieces = [];
        const clauses = t.split(/(?<=[,;])\s+|(?:\s+—\s+)|(?:\s+-\s+)/);
        let buf = "";

        for (const clause of clauses) {
          const c = clause.trim();
          if (!c) continue;
          if (!buf) buf = c;
          else if (buf.length + 1 + c.length <= maxLen) buf += " " + c;
          else {
            pieces.push(buf);
            buf = c;
          }
        }
        if (buf) pieces.push(buf);

        const out = [];
        for (const piece of pieces) {
          if (piece.length <= maxLen) {
            out.push(piece);
            continue;
          }
          const words = piece.split(/\s+/);
          let wb = "";
          for (const w of words) {
            if (!wb) wb = w;
            else if (wb.length + 1 + w.length <= maxLen) wb += " " + w;
            else {
              out.push(wb);
              wb = w;
            }
          }
          if (wb) out.push(wb);
        }
        return out;
      }

      function splitIntoSentences(text) {
        if (!text || text.trim().length === 0) return [];

        const raw = text
          .replace(/([.!?…])\s+(?=[A-Z"'’])/g, "$1|||")
          .split("|||")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        const merged = [];
        let buffer = "";

        for (const sentence of raw) {
          buffer = buffer ? buffer + " " + sentence : sentence;
          if (buffer.length >= 20) {
            merged.push(buffer);
            buffer = "";
          }
        }
        if (buffer) {
          if (merged.length > 0) merged[merged.length - 1] += " " + buffer;
          else merged.push(buffer);
        }

        const chunks = [];
        for (let i = 0; i < merged.length; i++) {
          const maxLen = i === 0 ? FIRST_CHUNK_MAX : CHUNK_MAX;
          chunks.push(...splitToMaxLen(merged[i], maxLen));
        }
        return chunks;
      }

      function ensureAudioContext(rate) {
        const r = rate && rate > 0 ? rate : 24000;
        if (!ttsAudioCtx || ttsAudioCtx.state === "closed" || ttsAudioCtx.sampleRate !== r) {
          try {
            if (ttsAudioCtx) ttsAudioCtx.close();
          } catch (_) {}
          ttsAudioCtx = new AudioContext({ sampleRate: r });
        }
        if (ttsAudioCtx.state === "suspended") ttsAudioCtx.resume();
        ttsSampleRate = r;
        return ttsAudioCtx;
      }

      let speakSession = null;
      let prefetchInFlight = 0;

      function finishSpeak(endCallback, naturalEnd) {
        if (!naturalEnd) {
          if (speakResolve) {
            const r = speakResolve;
            speakResolve = null;
            speakOnEnd = null;
            r();
          }
          return;
        }
        ttsIsPlaying = false;
        const onEnd = endCallback || speakOnEnd;
        speakOnEnd = null;
        if (speakResolve) {
          const r = speakResolve;
          speakResolve = null;
          onEnd?.();
          r();
        }
      }

      function abortPlayback(logStop) {
        if (speakSession) {
          speakSession.aborted = true;
          speakSession.streamingOpen = false;
        }
        ttsIsPlaying = false;
        if (ttsCurrentSource) {
          try {
            ttsCurrentSource.stop(0);
          } catch (_) {}
          ttsCurrentSource = null;
          if (logStop) console.log("[TTS Stream] Playback stopped");
        }
      }

      function stopTtsPlayback() {
        abortPlayback(true);
      }

      function stop() {
        speakOnEnd = null;
        abortPlayback(true);
        speakSession = null;
        finishSpeak(null, false);
      }

      async function generateTtsForSentence(text) {
        const startTime = Date.now();
        prefetchInFlight++;
        try {
          const tok = token || "";
          const res = await fetch(apiUrl("/api/jarvis/voice"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: tok ? `Bearer ${tok}` : "",
            },
            body: JSON.stringify({ text: text.slice(0, 1200) }),
          });
          if (!res.ok) {
            console.error("[TTS Stream] TTS API error:", res.status);
            return null;
          }
          const sampleRate = parseInt(res.headers.get("X-Sample-Rate") || "24000", 10);
          const buf = await res.arrayBuffer();
          const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 24000;
          const pcm = new Int16Array(buf);
          const ctx = ensureAudioContext(rate);
          const audioBuffer = ctx.createBuffer(1, pcm.length, rate);
          const ch = audioBuffer.getChannelData(0);
          for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;

          const elapsed = Date.now() - startTime;
          console.log(
            "[TTS Stream] Generated in",
            elapsed + "ms for:",
            text.substring(0, 40),
            "—",
            rate,
            "Hz,",
            buf.byteLength,
            "bytes",
          );

          return audioBuffer;
        } catch (err) {
          console.error("[TTS Stream] Generation error:", err);
          return null;
        } finally {
          prefetchInFlight--;
        }
      }

      function playAudioBuffer(audioBuffer, text, chunkNum, total) {
        return new Promise((resolve) => {
          if (!ttsIsPlaying || speakSession?.aborted) {
            resolve();
            return;
          }

          const ctx = ensureAudioContext(ttsSampleRate);
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(ctx.destination);
          ttsCurrentSource = source;
          ttsIsPlaying = true;

          console.log(
            "[TTS Stream] Sentence",
            chunkNum + "/" + total,
            "— playing",
            audioBuffer.duration.toFixed(2) + "s:",
            text.substring(0, 50),
          );

          source.onended = () => {
            ttsCurrentSource = null;
            resolve();
          };
          source.start(0);
        });
      }

      async function runPlayLoop() {
        const s = speakSession;
        if (!s) return;

        let hasStarted = false;
        let currentPromise =
          s.chunks.length > 0 ? generateTtsForSentence(s.chunks[0]) : Promise.resolve(null);
        let i = 0;

        while (true) {
          if (s.aborted || !ttsIsPlaying) {
            s.aborted = true;
            break;
          }

          if (i >= s.chunks.length) {
            if (s.streamingOpen) {
              await new Promise((r) => setTimeout(r, 50));
              if (i < s.chunks.length) continue;
            }
            break;
          }

          if (!currentPromise) {
            currentPromise = generateTtsForSentence(s.chunks[i]);
          }

          const audioBuffer = await currentPromise;

          let nextPromise = null;
          if (i + 1 < s.chunks.length) {
            nextPromise = generateTtsForSentence(s.chunks[i + 1]);
          }

          if (!audioBuffer) {
            currentPromise = nextPromise || Promise.resolve(null);
            i++;
            continue;
          }

          if (!hasStarted) {
            hasStarted = true;
            s.options?.onStart?.();
          }

          if (s.aborted || !ttsIsPlaying) {
            s.aborted = true;
            break;
          }

          await playAudioBuffer(audioBuffer, s.chunks[i], i + 1, s.chunks.length);

          currentPromise = nextPromise || Promise.resolve(null);
          i++;

          if (s.aborted || !ttsIsPlaying) {
            s.aborted = true;
            break;
          }
        }

        ttsIsPlaying = false;
        ttsCurrentSource = null;
        const wasAborted = s.aborted;
        const endCb = wasAborted ? null : s.options?.onEnd;
        speakSession = null;
        if (!wasAborted) {
          console.log("[Harvey] TTS queue empty — all audio done, re-enabling mic");
        }
        finishSpeak(endCb, !wasAborted);
      }

      function speak(fullText, options) {
        const clean = stripForSpeech(fullText);
        if (!clean) return Promise.resolve();

        speakOnEnd = null;
        abortPlayback(false);

        const chunks = splitIntoSentences(clean);
        if (!chunks.length) return Promise.resolve();

        console.log(
          "[TTS Stream] Splitting into",
          chunks.length,
          "chunks — firing parallel pre-generation for first 1",
        );

        ttsIsPlaying = true;

        speakSession = {
          chunks,
          index: 0,
          options: options || {},
          aborted: false,
          streamingOpen: Boolean(options?.streamingOpen),
        };

        return new Promise((resolve) => {
          speakResolve = resolve;
          speakOnEnd = options?.onEnd;
          void runPlayLoop();
        });
      }

      function appendRemainingText(fullText, options) {
        const all = splitIntoSentences(stripForSpeech(fullText));
        const s = speakSession;

        if (!s || s.aborted) {
          void speak(fullText, options);
          return;
        }

        const earlyCount = s.chunks.length;
        const remaining = all.slice(earlyCount);
        s.streamingOpen = false;

        if (options?.onEnd) {
          const prev = s.options.onEnd;
          s.options.onEnd = () => {
            prev?.();
            options.onEnd?.();
          };
        }

        if (!remaining.length) return;

        s.chunks.push(...remaining);
      }

      let prewarmDone = false;

      async function prewarmTts() {
        if (prewarmDone) return;
        prewarmDone = true;
        try {
          console.log("[TTS] Pre-warming Gemini TTS connection...");
          await generateTtsForSentence("Ready.");
          console.log("[TTS] Pre-warm complete");
        } catch (e) {
          console.log("[TTS] Pre-warm failed (non-critical):", e?.message || e);
          prewarmDone = false;
        }
      }

      function enqueueTtsSentence(text) {
        if (!text || !text.trim()) return;
        void speak(text.trim());
      }

      function isActive() {
        return (
          ttsIsPlaying ||
          ttsCurrentSource !== null ||
          (speakSession && !speakSession.aborted)
        );
      }

      function unlock() {
        if (!ttsAudioCtx) ttsAudioCtx = new AudioContext({ sampleRate: 24000 });
        if (ttsAudioCtx.state === "suspended") ttsAudioCtx.resume();
      }

      return {
        speak,
        stop,
        isActive,
        unlock,
        splitIntoSentences,
        appendRemainingText,
        prewarm: prewarmTts,
      };
    })();
})();
