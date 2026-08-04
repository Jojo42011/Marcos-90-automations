/**
 * Source-assertion suite for the conversational playbook work
 * (docs: the Conversational Voice Agent Playbook — §9 "pin the prompt with
 * tests"). Prompts rot silently; every behavior Marco asked for gets an
 * assertion here so a future line-range edit can't delete a section unnoticed.
 *
 * Run AFTER `npm run build`:  node scripts/verify-conversational-playbook.mjs
 * Functional checks import the compiled dist modules; source checks grep the
 * actual files (source of truth for the client, which has no build step).
 */

import { readFileSync } from "fs";
import assert from "assert";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err.message}`);
  }
}

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/* ── 1. Prompt architecture (§2) ─────────────────────────────────────────── */
const fp = await import("../dist/src/hull/founderPrompt.js");

check("prompt: five behavior sections present", () => {
  for (const section of [
    "HOW YOU TALK TO MARCO",
    "CONVERSATIONAL PACING",
    "WHEN HE'S JUST TALKING TO YOU",
    "HOLDING THE THREAD",
    "WHO YOU ARE CLONING",
  ]) {
    assert(fp.buildFounderSystemPrompt("").includes(section), `missing section: ${section}`);
  }
});

check("prompt: hand-the-ball-back rule is unhedged with explicit escape hatches", () => {
  assert(/HAND THE BALL BACK/.test(fp.CONVERSATIONAL_PACING));
  assert(/only three exceptions/i.test(fp.CONVERSATIONAL_PACING));
  assert(!/when it fits|sometimes|earned momentum/i.test(fp.CONVERSATIONAL_PACING.split("HAND THE BALL BACK")[1].split("\n")[0]));
});

check("prompt: social section carries verbatim exemplar lines", () => {
  const quotes = fp.SOCIAL_TURNS.match(/"[^"]{20,}"/g) || [];
  assert(quotes.length >= 3, `expected >=3 exemplars, found ${quotes.length}`);
  assert(/how can I help/i.test(fp.SOCIAL_TURNS) === false || /No "what do you need", no "how can I help"/.test(fp.SOCIAL_TURNS));
});

check("prompt: assistant-isms banned", () => {
  for (const ban of ['"Of course"', '"Certainly"', '"Absolutely"', '"Great question"', '"As an AI"']) {
    assert(fp.OPERATOR_PERSONALITY.includes(ban), `missing ban: ${ban}`);
  }
});

check("prompt: CORE/OPERATIONAL split — no tools means no operational half", () => {
  const withTools = fp.buildFounderSystemPrompt("", { hasTools: true });
  const noTools = fp.buildFounderSystemPrompt("", { hasTools: false });
  assert(withTools.includes("TOOL USAGE GUIDE"));
  assert(!noTools.includes("TOOL USAGE GUIDE"));
  assert(!noTools.includes("HONEST NUMBERS"));
  assert(noTools.length < withTools.length);
});

check("prompt: honest-numbers rules present in operational half", () => {
  assert(/Null is not zero/.test(fp.OPERATIONAL_PROMPT));
  assert(/the top few/.test(fp.OPERATIONAL_PROMPT));
  assert(/FAILED lookup/.test(fp.OPERATIONAL_PROMPT));
  assert(/ASK WHICH ONE/.test(fp.OPERATIONAL_PROMPT));
});

check("prompt: voice register only in voice mode, with NO YAPPING contract", () => {
  const voice = fp.buildFounderSystemPrompt("", { voiceMode: true });
  const text = fp.buildFounderSystemPrompt("", { voiceMode: false });
  assert(voice.includes("NO YAPPING"));
  assert(!text.includes("NO YAPPING"));
  assert(/one turn in three/.test(fp.VOICE_REGISTER));
  assert(/never the same one twice/.test(fp.VOICE_REGISTER));
});

check("prompt: every suggested vocal inflection contains a vowel (TTS drops vowel-less)", () => {
  const quoted = fp.VOICE_REGISTER.match(/"([^"]+)"/g) || [];
  for (const q of quoted) {
    const inner = q.slice(1, -1);
    if (inner.split(/\s+/).length <= 3) {
      assert(/[aeiou]/i.test(inner), `vowel-less inflection reached the prompt: ${inner}`);
    }
  }
  assert(!/"hm+"|"mm+"/i.test(fp.VOICE_REGISTER), "hm/mm must never be suggested");
});

check("prompt: standing orders and conversation state are injected when provided", () => {
  const sys = fp.buildFounderSystemPrompt("", {
    standingOrders: ["Never suggest a Zillow link"],
    conversationState: "CONVERSATION STATE (rebuilt this turn)\n- test",
    conversationSummary: "They discussed Canyon Lake.",
  });
  assert(sys.includes("STANDING ORDERS FROM MARCO"));
  assert(sys.includes("Never suggest a Zillow link"));
  assert(sys.includes("CONVERSATION STATE"));
  assert(sys.includes("CONVERSATION SO FAR"));
});

/* ── 2. Persona trait dials (§3) ─────────────────────────────────────────── */
const pt = await import("../dist/src/hull/personaTraits.js");

check("dials: six traits, defaults in range, assertiveness deliberately 0.75", () => {
  const t = pt.DEFAULT_TRAITS;
  for (const k of ["warmth", "humor", "formality", "energy", "empathy", "assertiveness"]) {
    assert(typeof t[k] === "number" && t[k] >= 0 && t[k] <= 1, `bad default: ${k}`);
  }
  assert(t.assertiveness === 0.75);
});

check("dials: clamping rejects junk and bounds values", () => {
  const c = pt.clampTraits({ humor: 7, warmth: -2, formality: "loud", energy: 0.5 });
  assert(c.humor === 1 && c.warmth === 0 && c.energy === 0.5 && !("formality" in c));
});

check("dials: bands change the prompt block as a dial moves", () => {
  const low = pt.buildPersonaBlock({ ...pt.DEFAULT_TRAITS, formality: 0.1 });
  const high = pt.buildPersonaBlock({ ...pt.DEFAULT_TRAITS, formality: 0.9 });
  assert(low.includes("guy in a truck"));
  assert(high.includes("formal and precise"));
  assert(low !== high);
});

check("dials: persona block is inside the built prompt", () => {
  assert(fp.buildFounderSystemPrompt("").includes("PERSONALITY DIALS"));
});

/* ── 3. Continuity layer (§4) ────────────────────────────────────────────── */
const conv = await import("../dist/src/hull/conversation.js");

check("continuity: same sitting vs new sitting at the 45-minute boundary", () => {
  const now = new Date("2026-08-04T12:00:00Z");
  const recent = [{ role: "user", content: "hey", at: "2026-08-04T11:50:00Z" }];
  const stale = [{ role: "user", content: "hey", at: "2026-08-04T09:00:00Z" }];
  assert(/Same sitting/.test(conv.buildConversationState(recent, now)));
  assert(/NEW sitting/.test(conv.buildConversationState(stale, now)));
  assert(conv.buildConversationState([], now) === "");
});

check("continuity: open-question tracking — his message is the ANSWER", () => {
  const turns = [
    { role: "user", content: "what's hot", at: new Date().toISOString() },
    { role: "assistant", content: "Three hot leads. Want the list?", at: new Date().toISOString() },
  ];
  assert(/ANSWER/.test(conv.buildConversationState(turns)));
  const noQ = [{ role: "assistant", content: "Done.", at: new Date().toISOString() }];
  assert(!/ANSWER/.test(conv.buildConversationState(noQ)));
});

check("continuity: deictic retrieval blends prior user turns", () => {
  const turns = [
    { role: "user", content: "pull up Pete Morales from the lead list" },
    { role: "assistant", content: "Got him." },
  ];
  const q = conv.buildRetrievalQuery("what about him?", turns);
  assert(q.includes("Pete Morales"));
  const specific = "show me the full TikTok performance report for July with view counts";
  assert(conv.buildRetrievalQuery(specific, turns) === specific);
});

/* ── 4. Social-turn routing (§7) ─────────────────────────────────────────── */
const mr = await import("../dist/src/hull/modelRouting.js");

check("routing: pleasantries are social; business and ambiguity are not", () => {
  for (const s of ["how are you", "Hey", "good morning", "thanks man", "what's up harvey", "you there?"]) {
    assert(mr.isSocialTurn(s), `should be social: ${s}`);
  }
  for (const s of [
    "how are the leads looking",
    "hey can you email Pete",
    "good morning, what's on the board",
    "how's the canyon lake listing",
    "tell me a joke about houses",
  ]) {
    assert(!mr.isSocialTurn(s), `should NOT be social: ${s}`);
  }
});

check("routing: agentLoop wires social turns to no-tools + fast model", () => {
  const src = read("src/hull/agentLoop.ts");
  assert(/socialTurn\s*=\s*isSocialTurn\(opts\.message\)/.test(src));
  assert(/!socialTurn\s*&&/.test(src), "toolsEnabled must be gated on !socialTurn");
  assert(/socialTurn\s*\?\s*getHaikuModel\(\)/.test(src), "social turns must route to Haiku");
  assert(/hasTools:\s*toolsEnabled/.test(src), "operational prompt half must follow tool gating");
  assert(/buildRetrievalQuery\(opts\.message,\s*timedHistory\)/.test(src));
  assert(/opts\.voiceMode\s*\?\s*320\s*:/.test(src), "voice output reserve should be 320");
});

/* ── 5. Spoken numbers (§6.2) ────────────────────────────────────────────── */
const sn = await import("../dist/src/hull/voice/speakNumbers.js");

check("speech: money", () => {
  assert.equal(sn.speakNumbers("$40k"), "forty thousand dollars");
  assert(sn.speakNumbers("$425,000").startsWith("four hundred twenty-five thousand dollars"));
  assert.equal(sn.speakNumbers("$1.2M"), "one million two hundred thousand dollars");
  assert.equal(sn.speakNumbers("$99.50"), "ninety-nine dollars and fifty cents");
});

check("speech: phone numbers read digit by digit", () => {
  const out = sn.speakNumbers("(210) 718-3874");
  assert.equal(out, "two one zero, seven one eight, three eight seven four");
  assert(!/\d/.test(out));
});

check("speech: times, percents, ordinals, years, decimals, ranges", () => {
  assert.equal(sn.speakNumbers("3:30pm"), "three thirty P M");
  assert.equal(sn.speakNumbers("12%"), "twelve percent");
  assert.equal(sn.speakNumbers("2nd"), "second");
  assert.equal(sn.speakNumbers("2026"), "twenty twenty-six");
  assert.equal(sn.speakNumbers("3.5"), "three point five");
  assert.equal(sn.speakNumbers("6-8"), "six to eight");
  assert.equal(sn.speakNumbers("725"), "seven hundred twenty-five");
  assert.equal(sn.speakNumbers("6,006"), "six thousand six");
});

check("speech: acronyms spelled out", () => {
  assert(sn.speakNumbers("update the CRM").includes("C R M"));
  assert(sn.speakNumbers("GCI is up").includes("G C I"));
});

check("speech: sanitizeForSpeech strips markdown then speaks numbers", () => {
  const out = sn.sanitizeForSpeech("**Top lead:** Pete, $365k");
  assert(!out.includes("*"));
  assert(out.includes("three hundred sixty-five thousand dollars"));
});

check("speech: wired into generateTTS (the mouth), not the UI", () => {
  const tts = read("src/hull/voice/tts.ts");
  assert(/sanitizeForSpeech\(rawText\)/.test(tts));
});

/* ── 6. Standing orders (§8) ─────────────────────────────────────────────── */
check("orders: change_agent_logic is a registered tool with add/remove/list", () => {
  const src = read("src/hull/tools.ts");
  assert(/CHANGE_AGENT_LOGIC_TOOL/.test(src));
  assert(/name === "change_agent_logic"/.test(src));
  assert(/TUNE_PERSONALITY_TOOL/.test(src));
  assert(/name === "tune_personality"/.test(src));
});

check("orders: prompt tells Harvey a 'stop doing X' is an instruction", () => {
  assert(/change_agent_logic/.test(fp.OPERATIONAL_PROMPT));
});

/* ── 7. Client turn-taking (§5) — source pins on the no-build-step files ─── */
const voiceJs = read("public/aethon-voice.js");
const jarvis = read("public/jarvis.html");

check("client: LiveKit-derived constants present with sane values", () => {
  assert(/BARGE_IN_GRACE_MS = 1000/.test(voiceJs));
  assert(/BARGE_IN_MIN_WORDS = 3/.test(voiceJs));
  assert(/FALSE_INTERRUPTION_TIMEOUT_MS = 2000/.test(voiceJs));
  assert(/POST_SPEECH_COOLDOWN_MS = 1200/.test(voiceJs));
  assert(/BARGE_IN_SUSTAIN_FRAMES = 4/.test(voiceJs));
});

check("client: backchannel + echo guards applied at COMMIT time inside the cooldown", () => {
  const gate = voiceJs.slice(voiceJs.indexOf("function shouldCommitTranscript"), voiceJs.indexOf("function scheduleCommit"));
  assert(/POST_SPEECH_COOLDOWN_MS/.test(gate));
  assert(/BACKCHANNEL_RE\.test\(t\)/.test(gate));
  assert(/isEchoOfHarvey\(t\)/.test(gate));
});

check("client: backchannel regex covers listening noises but a real 'yeah do it' passes", () => {
  const m = voiceJs.match(/const BACKCHANNEL_RE = (.*);/);
  assert(m, "BACKCHANNEL_RE missing");
  const re = eval(m[1]);
  for (const s of ["yeah", "mhm", "uh-huh", "got it", "okay"]) assert(re.test(s), `should match: ${s}`);
  for (const s of ["yeah do it", "stop", "call Pete", "yeah and also text him"]) assert(!re.test(s), `should NOT match: ${s}`);
});

check("client: false-interruption resume — park, verdict, resume or discard", () => {
  assert(/function parkHarvey/.test(voiceJs));
  assert(/function resumeFromFalseInterruption/.test(voiceJs));
  assert(/function handleParkedUtterance/.test(voiceJs));
  assert(/STOP_COMMAND_RE\.test\(text\)/.test(voiceJs), "explicit stop must discard");
  assert(/handleParkedUtterance\(\(finalText \|\| ""\)\.trim\(\)\)/.test(voiceJs), "EndOfTurn must route to the parked handler");
});

check("client: RMS barge-in has a start grace and a sustained-duration requirement", () => {
  assert(/Date\.now\(\) < bargeGraceUntil/.test(voiceJs));
  assert(/rmsRunFrames >= BARGE_IN_SUSTAIN_FRAMES/.test(voiceJs));
});

check("client: bridge phrase fires only when brain is slow and nothing has been spoken", () => {
  assert(/BRIDGE_PHRASE_AFTER_MS/.test(voiceJs));
  assert(/brainBusy && !isVoicePlaybackActive\(\)/.test(voiceJs));
  assert(/clearBridgeTimer\(\);\s*\n\s*pauseMicForHarveyResponse/.test(voiceJs) || /clearBridgeTimer\(\)/.test(voiceJs));
});

check("client: errors are spoken in Harvey's voice, not just shown", () => {
  assert(/rate limit/i.test(voiceJs));
  assert(/await speakText\(spokenLine\)/.test(voiceJs));
});

check("client: streaming TTS supports park/resume without destroying the queue", () => {
  assert(/function pause\(\)/.test(jarvis));
  assert(/function resume\(\)/.test(jarvis));
  assert(/s\.paused = true/.test(jarvis));
  assert(/pause,\s*\n\s*resume,/.test(jarvis));
  assert(/currentPromise = Promise\.resolve\(audioBuffer\)/.test(jarvis), "resume must replay the interrupted chunk");
});

check("server: first-sentence streamer never splits on an abbreviation", () => {
  const server = read("src/server.ts");
  assert(/mr\|mrs\|ms\|dr/.test(server), "abbreviation guard missing from findFirstSentenceBoundary");
});

check("wiring: runHarveyChat feeds timed history + session id into the loop", () => {
  const src = read("src/harvey/index.ts");
  assert(/timedHistory: history\.map/.test(src));
  assert(/sessionId,/.test(src));
});

check("wiring: session memory holds 24 turns, caps stored turns at 700 chars, folds evictions", () => {
  const src = read("src/harvey/memory.ts");
  assert(/MAX_TURNS = 24/.test(src));
  assert(/MAX_TURN_CHARS = 700/.test(src));
  assert(/noteEvictedTurns/.test(src));
});

/* ── Report ──────────────────────────────────────────────────────────────── */
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
