#!/usr/bin/env node
/**
 * Can Harvey actually talk and hear — against the REAL vendors, right now?
 *
 * The unit suite (verify-harvey-voice.mjs) stubs ElevenLabs, which is correct
 * for logic but is exactly why the 2026-08-17 outage got through: the stub
 * accepted a voice id the real account does not have. Nothing in the repo ever
 * asked the live service whether Harvey's configured voice could speak.
 *
 * So this one spends real credits on purpose, and does the only test that
 * settles it: Harvey says a sentence, and the audio he produced is streamed
 * back into his own ears. If the transcript comes back, both halves work.
 *
 *   node scripts/verify-harvey-voice-live.mjs [https://host]
 *
 * Needs ELEVENLABS_API_KEY when run against a local server; against production
 * the key already lives there and only the host is needed.
 */
import { WebSocket } from "ws";

const BASE = (process.argv[2] || "https://marco-90-automation.fly.dev").replace(/\/$/, "");
const TOKEN = process.env.DASHBOARD_TOKEN || "";
const q = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "";

let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const PHRASE = "The Blanco listing just went under contract.";

/* ── 1. Health: what does the system claim about itself? ── */
const health = await (await fetch(`${BASE}/health`)).json();
const v = health?.harvey?.voice || {};
console.log("\nreported:", JSON.stringify(v));
ok("an STT engine is named, not 'none'", v.engine && v.engine !== "none", String(v.engine));
ok("a TTS vendor is named", v.tts && v.tts !== "none", String(v.tts));
ok("health carries a speech block at all", v.speech !== undefined, JSON.stringify(v.speech));

/* ── 2. Can he speak? The configured voice, through the real API. ── */
let pcm = null;
{
  const r = await fetch(`${BASE}/api/jarvis/voice${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: PHRASE }),
  });
  if (r.ok) {
    pcm = Buffer.from(await r.arrayBuffer());
    const rate = Number(r.headers.get("X-Sample-Rate") || 0);
    ok("Harvey's configured voice produces real audio", pcm.length > 8000, `${pcm.length} bytes`);
    ok("at the sample rate the browser decoder expects", rate === 24000, String(rate));
    /* Silence would also be "audio" — check the waveform actually moves. */
    let peak = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    ok("and it is speech, not a buffer of silence", peak > 2000, `peak amplitude ${peak}`);
  } else {
    const body = await r.text().catch(() => "");
    ok("Harvey's configured voice produces real audio", false, `${r.status} ${body.slice(0, 300)}`);
  }
}

/* ── 3. Does health now tell the truth about that attempt? ── */
{
  const after = (await (await fetch(`${BASE}/health`)).json())?.harvey?.voice?.speech || {};
  ok("health reports the outcome of the last real attempt",
    after.lastOk === (pcm !== null), JSON.stringify(after));
  if (after.substitutedTo) {
    console.log(`  NOTE: speaking as ${after.substitutedTo} because ${after.substitutedFrom} was rejected.`);
  }
}

/* ── 4. Can he hear? Stream his own audio into the STT proxy. ── */
if (pcm) {
  const wsUrl = `${BASE.replace(/^http/, "ws")}/api/jarvis/elevenlabs/listen${q}`;
  const transcript = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let connected = false, text = "", settled = false;
    const done = (why) => { if (settled) return; settled = true; try { ws.close(); } catch {} resolve({ connected, text, why }); };

    ws.on("open", () => {
      /* The proxy expects 16 kHz PCM16; the TTS came back at 24 kHz, so
         downsample 3:2 before sending. Same job the browser's capture graph
         does, just in the other direction. */
      const src = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
      const outLen = Math.floor(src.length * 16000 / 24000);
      const out = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) out[i] = src[Math.floor(i * 24000 / 16000)];
      const bytes = Buffer.from(out.buffer, out.byteOffset, out.byteLength);

      const CHUNK = 16000 * 2 * 0.1;          // 100ms frames, as the mic sends
      let off = 0;
      const timer = setInterval(() => {
        if (ws.readyState !== 1) { clearInterval(timer); return; }
        if (off >= bytes.length) {
          clearInterval(timer);
          /* Trailing silence so the server-side VAD closes the turn. */
          const pad = Buffer.alloc(CHUNK);
          let n = 0;
          const t2 = setInterval(() => {
            if (ws.readyState !== 1 || n++ > 14) { clearInterval(t2); return; }
            ws.send(pad);
          }, 100);
          return;
        }
        ws.send(bytes.subarray(off, off + CHUNK));
        off += CHUNK;
      }, 100);
    });

    ws.on("message", (d) => {
      let m; try { m = JSON.parse(String(d)); } catch { return; }
      if (m.type === "Connected") { connected = true; return; }
      if (m.type === "TurnInfo") {
        if (m.transcript) text = m.transcript;
        if (m.event === "EndOfTurn") done("end of turn");
      }
    });
    ws.on("error", (e) => done("error " + e.message));
    ws.on("close", () => done("closed"));
    setTimeout(() => done("timeout"), 30000);
  });

  ok("the STT socket reaches the speech vendor", transcript.connected === true, transcript.why);
  console.log("  heard:", JSON.stringify(transcript.text));
  /* Word-level, because a transcriber is allowed to punctuate differently. */
  const heard = transcript.text.toLowerCase();
  ok("Harvey hears the words he just said",
    ["blanco", "listing", "contract"].filter((w) => heard.includes(w)).length >= 2,
    JSON.stringify(transcript.text));
}

/* ── 5. Does the audio actually DECODE in a browser? ──
   The server can return a perfectly valid buffer in a format the page cannot
   play — a sample-rate or endianness mismatch is silent in exactly the same
   way a missing voice is, so it gets checked in a real AudioContext rather
   than assumed from a byte count.

   This section needs a browser that can REACH `BASE`. In a sandboxed CI box
   whose only egress is an HTTP proxy the browser does not use, it cannot, and
   the check skips loudly rather than being quietly counted as a pass. */
let br = null;
try {
  const { chromium } = await import("playwright");
  br = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const page = await br.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(`${BASE}/operator${q}`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(2500);
  ok("the operator page loads with no script errors", errs.length === 0, errs.slice(0, 3).join(" | "));

  const decoded = await Promise.race([
    page.evaluate(async (phrase) => {
    const r = await fetch("/api/jarvis/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: phrase }),
    });
    if (!r.ok) return { ok: false, why: r.status + " " + (await r.text()).slice(0, 200) };
    const rate = parseInt(r.headers.get("X-Sample-Rate") || "0", 10);
    const buf = await r.arrayBuffer();
    /* The exact decode aethon-voice.js does: raw S16LE into a mono buffer. */
    const ctx = new AudioContext({ sampleRate: rate });
    const pcm = new Int16Array(buf);
    const ab = ctx.createBuffer(1, pcm.length, rate);
    const ch = ab.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) { ch[i] = pcm[i] / 32768; peak = Math.max(peak, Math.abs(ch[i])); }
    await ctx.close();
    return { ok: true, rate, seconds: ab.duration, peak };
    }, PHRASE),
    new Promise((r) => setTimeout(() => r({ ok: false, why: "decode timed out in the page" }), 30000)),
  ]);

  ok("the browser decodes Harvey's audio into a playable buffer", decoded.ok === true, JSON.stringify(decoded));
  if (decoded.ok) {
    ok("the decoded audio has real length", decoded.seconds > 0.5, `${decoded.seconds.toFixed(2)}s`);
    ok("and a real waveform, not silence", decoded.peak > 0.05, String(decoded.peak));
  }
} catch (e) {
  console.log("  SKIPPED (not counted): browser decode check could not run — " +
    String(e.message || e).split("\n")[0].slice(0, 110));
} finally {
  if (br) await br.close().catch(() => {});
}

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { fail.forEach((f) => console.error(" ✗ " + f)); process.exit(1); }
