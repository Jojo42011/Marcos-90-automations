#!/usr/bin/env node
/**
 * Harvey's voice: which one speaks, and how the choice is made.
 *
 * The failure modes worth proving are the quiet ones:
 *
 *   - the stored choice must BEAT ELEVENLABS_VOICE_ID. That secret is set in
 *     production, so a code-side default would be silently overridden and the
 *     voice would appear not to change at all.
 *   - voice_settings must actually be SENT. They were absent entirely before,
 *     which is most of why Harvey sounded flat.
 *   - the TTS cache must key on the VOICE, not just the words, or changing
 *     voice replays old audio in the old voice for every line already spoken.
 *   - a rejected voice id must be reported, not swallowed — Harvey simply
 *     going quiet points at nothing.
 *
 * ElevenLabs is stubbed locally; no credits are spent and no real call is made.
 *
 * Usage: node scripts/verify-harvey-voice.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

let pass = 0; const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok " + n); } else { fail.push(n + (d ? " — " + d : "")); console.error("FAIL " + n + (d ? " — " + d : "")); } };

const tmp = mkdtempSync(join(tmpdir(), "hv-"));
const profilePath = join(tmp, "voice-profile.json");

/* ---- stub ElevenLabs ---------------------------------------------------- */
const calls = [];
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/v1/voices") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ voices: [
        /* ElevenLabs returns premade voices with a descriptor appended, which
           is exactly what broke the first version of the name matching. */
        { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah - Mature, Reassuring, Confident", category: "premade" },
        { voice_id: "nPczCjzI2devNBz1zQrb", name: "Brian - Deep, Resonant and Comforting", category: "premade" },
        { voice_id: "CUSTOM123", name: "Marco Clone", category: "cloned" },
      ] }));
      return;
    }
    const m = /^\/v1\/text-to-speech\/([^?]+)/.exec(req.url || "");
    if (m) {
      const voiceId = decodeURIComponent(m[1]);
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      calls.push({ voiceId, body: parsed });
      if (voiceId === "AUTH_FAIL") {
        /* An account/service failure, NOT a voice failure — another voice id
           would fail identically, so the fallback must not be burned on it. */
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: { message: "Invalid API key" } }));
        return;
      }
      if (voiceId === "RETIRED_ID") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: { message: "A voice for voice_id RETIRED_ID was not found." } }));
        return;
      }
      /* 100 frames of silence is enough to prove the pipe carries audio. */
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(200));
      return;
    }
    res.writeHead(404); res.end("{}");
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;

/* The client hard-codes api.elevenlabs.io, so the stub is reached by pointing
   Node's DNS/undici at it via a global fetch shim in the child is not possible;
   instead the unit-level checks import the module with a patched global fetch. */
process.env.VOICE_PROFILE_PATH = profilePath;
process.env.ELEVENLABS_API_KEY = "stub-key";

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://api.elevenlabs.io")) {
    return realFetch(u.replace("https://api.elevenlabs.io", `http://127.0.0.1:${stubPort}`), init);
  }
  return realFetch(url, init);
};

const vp = await import("../dist/src/hull/voice/voiceProfile.js");
const tts = await import("../dist/src/hull/voice/tts.js");

try {
  // ---- defaults ----------------------------------------------------------
  {
    const p = vp.getVoiceProfile();
    ok("defaults to a warm assistant voice, not the old Rachel id",
      p.voiceId !== "21m00Tcm4TlvDq8ikWAM" && p.voiceName === "Sarah", JSON.stringify(p));
    ok("defaults to the soothing delivery preset", p.preset === "soothing");
    const d = vp.effectiveDelivery(p);
    ok("soothing means high stability", d.stability >= 0.7, String(d.stability));
    ok("similarity sits in the usable band", d.similarityBoost >= 0.75 && d.similarityBoost <= 0.9);
    ok("style stays at 0, per ElevenLabs' own guidance", d.style === 0);
    ok("speaker boost is on", d.speakerBoost === true);
  }

  // ---- voice_settings are actually sent ----------------------------------
  {
    calls.length = 0;
    const out = await tts.generateTTS("Good morning Marco.");
    ok("TTS returns audio", !!out && out.pcm.length > 0);
    ok("exactly one request went out", calls.length === 1, String(calls.length));
    const body = calls[0].body;
    ok("voice_settings ARE sent (they were absent before)", !!body.voice_settings, JSON.stringify(body));
    ok("stability is carried", body.voice_settings.stability >= 0.7);
    ok("similarity_boost is carried", body.voice_settings.similarity_boost >= 0.75);
    ok("use_speaker_boost is carried", body.voice_settings.use_speaker_boost === true);
    ok("the model stays Flash v2.5 for real-time", body.model_id === "eleven_flash_v2_5", String(body.model_id));
    ok("it called the chosen voice", calls[0].voiceId === "EXAVITQu4vr4xnSDxMaL", calls[0].voiceId);
  }

  // ---- the cache must not serve the old voice ----------------------------
  {
    calls.length = 0;
    await tts.generateTTS("A repeated line.");
    await tts.generateTTS("A repeated line.");
    ok("the same line in the same voice is cached", calls.length === 1, String(calls.length));

    vp.setVoiceProfile({ voiceId: "nPczCjzI2devNBz1zQrb", voiceName: "Brian" });
    calls.length = 0;
    await tts.generateTTS("A repeated line.");
    ok("changing voice does NOT replay cached audio in the old voice",
      calls.length === 1 && calls[0].voiceId === "nPczCjzI2devNBz1zQrb",
      JSON.stringify(calls.map((c) => c.voiceId)));
  }

  // ---- delivery changes also bust the cache ------------------------------
  {
    await tts.generateTTS("Delivery test.");
    calls.length = 0;
    vp.setVoiceProfile({ preset: "expressive" });
    await tts.generateTTS("Delivery test.");
    ok("changing the delivery preset re-renders too", calls.length === 1, String(calls.length));
    ok("and the new numbers are sent", calls[0].body.voice_settings.stability < 0.5,
      String(calls[0].body.voice_settings.stability));
  }

  // ---- persistence + precedence over the env secret -----------------------
  {
    vp.setVoiceProfile({ voiceId: "CUSTOM123", voiceName: "Marco Clone", preset: "soothing" }, "Jahan");
    ok("the choice is written to disk", existsSync(profilePath));
    const raw = JSON.parse(readFileSync(profilePath, "utf8"));
    ok("and records who changed it", raw.updatedBy === "Jahan" && !!raw.updatedAt, JSON.stringify(raw));

    /* The production case: a Fly secret pins a DIFFERENT voice. The stored
       choice has to win, or changing the voice in the UI does nothing. */
    process.env.ELEVENLABS_VOICE_ID = "SOME_OTHER_SECRET_ID";
    vp.clearVoiceProfileCache();
    const p = vp.getVoiceProfile();
    ok("the stored choice BEATS ELEVENLABS_VOICE_ID", p.voiceId === "CUSTOM123", JSON.stringify(p));

    /* With nothing stored, the env var should still be honoured. */
    rmSync(profilePath, { force: true });
    vp.clearVoiceProfileCache();
    const q = vp.getVoiceProfile();
    ok("with nothing stored, the env var is honoured", q.voiceId === "SOME_OTHER_SECRET_ID", JSON.stringify(q));
    delete process.env.ELEVENLABS_VOICE_ID;
    vp.clearVoiceProfileCache();
  }

  // ---- a rejected voice must never mean silence --------------------------
  /* THIS IS THE 2026-08-17 OUTAGE, as a test. A voice id that ElevenLabs does
     not have was saved; every call 404'd; Harvey said nothing at all for a day
     and /health reported him healthy the whole time. Three things have to hold
     now: he keeps talking, the substitution is visible, and the bad id is not
     retried on every single utterance. */
  {
    tts.clearTtsCache();
    process.env.ELEVENLABS_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";   // a voice that works
    vp.setVoiceProfile({ voiceId: "RETIRED_ID", voiceName: "Gone" });
    const errs = [];
    const realErr = console.error;
    console.error = (...a) => errs.push(a.join(" "));
    const before = calls.length;
    const out = await tts.generateTTS("Harvey must still be able to say this.");
    console.error = realErr;

    ok("a rejected voice falls back instead of going silent", out !== null && out.pcm.length > 0,
      out ? String(out.pcm.length) : "null");
    ok("it tried the configured voice first, then the fallback",
      calls.slice(before).map((c) => c.voiceId).join(",") === "RETIRED_ID,EXAVITQu4vr4xnSDxMaL",
      calls.slice(before).map((c) => c.voiceId).join(","));
    ok("and it says WHICH voice was rejected and where to fix it",
      errs.some((e) => /RETIRED_ID/.test(e) && /api\/harvey\/voice/.test(e)), errs.join(" | ").slice(0, 200));

    const h = tts.ttsHealthReport();
    ok("health reports that a substitution is in force",
      h.lastOk === true && h.substitutedFrom === "RETIRED_ID" && h.substitutedTo === "EXAVITQu4vr4xnSDxMaL",
      JSON.stringify(h));

    /* Second line: the dead voice must not be attempted again. Paying a doomed
       round trip per utterance would turn a fixed bug into a latency bug. */
    const before2 = calls.length;
    const again = await tts.generateTTS("A second, different line.");
    ok("a known-bad voice is not retried on later lines",
      again !== null && !calls.slice(before2).some((c) => c.voiceId === "RETIRED_ID"),
      calls.slice(before2).map((c) => c.voiceId).join(","));

    /* An ACCOUNT failure is a different class from a bad voice: every other
       voice id would fail the same way, so trying them is pointless noise —
       and the outcome has to be recorded rather than looking fine, which is
       precisely what was missing before. */
    tts.clearTtsCache();
    delete process.env.ELEVENLABS_VOICE_ID;
    vp.setVoiceProfile({ voiceId: "AUTH_FAIL", voiceName: "Bad account" });
    const before3 = calls.length;
    console.error = () => {};
    const dead = await tts.generateTTS("Nothing can speak this.");
    console.error = realErr;
    const h2 = tts.ttsHealthReport();
    ok("an account-level failure yields no audio", dead === null);
    ok("and does not pointlessly burn the fallback voices",
      calls.slice(before3).length === 1, calls.slice(before3).map((c) => c.voiceId).join(","));
    ok("and health records the failure rather than looking fine",
      h2.lastOk === false && /401/.test(String(h2.lastError)), JSON.stringify(h2));
    tts.clearTtsCache();
  }

  // ---- the id list must match the account, not our memory of it ----------
  /* The outage was ultimately a wrong constant: River's id was written from
     memory and no code path ever compared it to reality. */
  {
    const river = vp.RECOMMENDED_VOICES.find((v) => v.name === "River");
    ok("the River id is the corrected one, not the id that broke Harvey",
      river && river.id === "SAz9YHcvj6GT2YYXdXww", JSON.stringify(river));
    ok("no recommendation still carries the bad id",
      !vp.RECOMMENDED_VOICES.some((v) => v.id === "SAz9YHcvj6BLoDVoivEZ"));
  }

  // ---- an id the account does not have is refused BEFORE it is stored -----
  {
    ok("a voice the account has is confirmed",
      (await vp.voiceExistsOnAccount("EXAVITQu4vr4xnSDxMaL")) === true);
    ok("a voice the account does not have is caught",
      (await vp.voiceExistsOnAccount("NOT_A_REAL_ID")) === false);
    const savedKey = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    ok("with no key it returns null, so a blip cannot block a real save",
      (await vp.voiceExistsOnAccount("EXAVITQu4vr4xnSDxMaL")) === null);
    process.env.ELEVENLABS_API_KEY = savedKey;
  }

  // ---- clamping ----------------------------------------------------------
  {
    vp.setVoiceProfile({ voiceId: "EXAVITQu4vr4xnSDxMaL", delivery: { stability: 9, similarityBoost: -3, style: 0.2, speakerBoost: false } });
    const d = vp.effectiveDelivery(vp.getVoiceProfile());
    ok("out-of-range delivery numbers are clamped, not passed through",
      d.stability === 1 && d.similarityBoost === 0, JSON.stringify(d));
    vp.setVoiceProfile({ speed: 5 });
    ok("speed is clamped to the supported band", vp.getVoiceProfile().speed === 1.2, String(vp.getVoiceProfile().speed));
    /* Picking a preset must clear a hand-tune or the preset appears inert. */
    vp.setVoiceProfile({ preset: "natural" });
    ok("choosing a preset clears a previous hand-tune",
      vp.effectiveDelivery(vp.getVoiceProfile()).stability === 0.55,
      JSON.stringify(vp.effectiveDelivery(vp.getVoiceProfile())));
  }

  // ---- the picker must not call a present voice "unavailable" -------------
  {
    /* The live account returns "Sarah - Mature, Reassuring, Confident". An
       exact-string compare misses every premade voice and the panel greys them
       out as missing — telling the operator a working voice cannot be used. */
    const lead = (n) => n.split(/\s+[-–—]\s+/)[0].trim().toLowerCase();
    ok("a recommended name matches a descriptor-suffixed account voice",
      lead("Sarah - Mature, Reassuring, Confident") === lead("Sarah"));
    ok("and it does not over-match a different voice",
      lead("Sarah - Mature") !== lead("Sam - Mature"));
  }

  ok("a corrupt profile file does not take the voice out",
    (() => {
      writeFileSync(profilePath, "{ this is not json");
      vp.clearVoiceProfileCache();
      const p = vp.getVoiceProfile();
      return !!p.voiceId;
    })());
} finally {
  stub.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail.length} checks passed`);
if (fail.length) { console.error("FAILURES:\n - " + fail.join("\n - ")); process.exit(1); }
