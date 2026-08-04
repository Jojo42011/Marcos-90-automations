"use strict";
/**
 * Personality as trait dials, not prose (conversational playbook §3, modeled
 * on voice-persona-engine's trait-vector idea).
 *
 * Six numbers, each 0.0–1.0, mapped through five descriptor bands into the
 * prompt. The point of dials: Marco says "be funnier" or "less formal" and ONE
 * number moves — exposed as the tune_personality tool so he can turn them by
 * voice. The dials shape GENERATION only; nothing post-processes finished text
 * (the playbook explicitly rejected post-hoc rewriting as the canned feel
 * you're escaping — houseStyle's stripAiTypography moves punctuation, never
 * words, which is a different thing).
 *
 * Persisted in aethon-memory.db system_state so a tune survives a restart.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TRAITS = void 0;
exports.clampTraits = clampTraits;
exports.getPersonaTraits = getPersonaTraits;
exports.setPersonaTraits = setPersonaTraits;
exports.resetPersonaTraits = resetPersonaTraits;
exports.buildPersonaBlock = buildPersonaBlock;
const store_js_1 = require("./memory/store.js");
/**
 * Harvey's calibration. Formality is higher and warmth lower than the
 * playbook's Arlo numbers because Harvey's register is JARVIS-precision, not
 * guy-in-a-truck. Assertiveness deliberately 0.75, not 0.8+: the top band
 * reads "blunt to the point of stubborn", which is worse than "has a spine".
 */
exports.DEFAULT_TRAITS = {
    warmth: 0.55,
    humor: 0.6,
    formality: 0.55,
    energy: 0.6,
    empathy: 0.5,
    assertiveness: 0.75,
};
const TRAIT_KEYS = Object.keys(exports.DEFAULT_TRAITS);
const STATE_KEY = "harvey_persona_traits";
function band(level, bands) {
    if (level < 0.2)
        return bands[0];
    if (level < 0.4)
        return bands[1];
    if (level < 0.6)
        return bands[2];
    if (level < 0.8)
        return bands[3];
    return bands[4];
}
/* Bands written for a SPOKEN assistant — each one is a playable direction,
   not an adjective. */
const BANDS = {
    warmth: [
        "detached and clinical; zero small warmth",
        "cool and reserved; warmth only when earned",
        "professionally warm; on his side without gushing",
        "openly warm; clearly invested in how his day is going",
        "effusive; every reply radiates care",
    ],
    humor: [
        "no humor at all; strictly business",
        "a dry aside at most, rarely",
        "dry wit when the moment fits; never forced",
        "quick and playful; a wry line most exchanges",
        "constantly joking; comic first, useful second",
    ],
    formality: [
        "talk like a guy in a truck: contractions, fragments, slang",
        "casual and loose; no corporate register at all",
        "relaxed but tidy; contractions welcome, slang rare",
        "professional and composed; measured sentences",
        "formal and precise; full sentences, no slang ever",
    ],
    energy: [
        "flat and unhurried; almost sleepy",
        "calm and level; nothing excites you",
        "steady with a quicker gear when news is good or urgent",
        "brisk and animated; momentum in every reply",
        "high-octane; everything is urgent and thrilling",
    ],
    empathy: [
        "ignore feelings entirely; facts only",
        "acknowledge mood in passing, then move on",
        "read his state and adjust pace, without making it a topic",
        "name what he's feeling and meet it before the business",
        "lead with feelings every time, business second",
    ],
    assertiveness: [
        "defer to him on everything; never push",
        "offer options, recommend gently",
        "recommend clearly, accept pushback fast",
        "have a spine: recommend, defend it once, then commit to his call",
        "blunt to the point of stubborn; argue past his decision",
    ],
};
function clampTraits(input) {
    const out = {};
    for (const key of TRAIT_KEYS) {
        const v = input[key];
        if (typeof v === "number" && Number.isFinite(v)) {
            out[key] = Math.min(1, Math.max(0, v));
        }
    }
    return out;
}
function getPersonaTraits() {
    try {
        const raw = (0, store_js_1.getSystemState)(STATE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            return { ...exports.DEFAULT_TRAITS, ...clampTraits(parsed) };
        }
    }
    catch {
        /* corrupt state falls back to defaults */
    }
    return { ...exports.DEFAULT_TRAITS };
}
function setPersonaTraits(update) {
    const merged = { ...getPersonaTraits(), ...clampTraits(update) };
    (0, store_js_1.setSystemState)(STATE_KEY, JSON.stringify(merged));
    return merged;
}
function resetPersonaTraits() {
    (0, store_js_1.setSystemState)(STATE_KEY, JSON.stringify(exports.DEFAULT_TRAITS));
    return { ...exports.DEFAULT_TRAITS };
}
/** The prompt block the dials compile into. Rebuilt every call, so a tune
 *  applies to the very next generation. */
function buildPersonaBlock(traits = getPersonaTraits()) {
    return [
        "PERSONALITY DIALS (tunable; Marco can say \"be funnier\" / \"less formal\" and tune_personality moves one)",
        `- Warmth: ${band(traits.warmth, BANDS.warmth)}`,
        `- Humor: ${band(traits.humor, BANDS.humor)}`,
        `- Formality: ${band(traits.formality, BANDS.formality)}`,
        `- Energy: ${band(traits.energy, BANDS.energy)}`,
        `- Empathy: ${band(traits.empathy, BANDS.empathy)}`,
        `- Assertiveness: ${band(traits.assertiveness, BANDS.assertiveness)}`,
    ].join("\n");
}
