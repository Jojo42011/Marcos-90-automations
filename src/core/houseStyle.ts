/**
 * How Harvey writes.
 *
 * Marco's complaint, verbatim, looking at a task Harvey had just created:
 * *"a lot of m dashes and, like, a lot of those AI type looking features…
 * let it be as human as possible."* He was right. The task read:
 *
 *   "Chase top 10 Contacted buyers — get them on the phone"
 *   "All 228 buyers in Contacted stage actually HAVE phones — good news."
 *   "1. Raul Trevino — (210) 718-3874 — STATUS: HOT 🔥"
 *
 * Nobody on a real-estate team types that. It is a machine performing
 * helpfulness at someone who just wants a call list.
 *
 * TWO LAYERS, AND THE SPLIT IS DELIBERATE. The DM side of this codebase solved
 * this exact problem years-of-commits ago and Harvey never got the fix:
 * `GLOBAL_MARCO_DM_RULES` bans the em dash in the prompt, AND
 * `enforceOutboundTextRules()` strips it in code on the way out. That second
 * layer exists because — as its own doc comment says — prompt-only enforcement
 * is not reliable; the ban was already in the prompt when a live lead got
 * "Yeah, of course — is there a good number". So:
 *
 *   - `HARVEY_HOUSE_STYLE` is INSTRUCTION. It covers voice, and voice cannot be
 *     regex'd. It will be followed most of the time, not all of it.
 *   - `stripAiTypography()` is a GUARANTEE. It is mechanical, meaning-preserving
 *     and runs after the model, so an em dash cannot reach the board whatever
 *     the model wrote.
 *
 * Only claim the guarantee for the half that is one. The punctuation is fixed;
 * "sounds human" is steered.
 *
 * WHY THIS IS NOT APPLIED TO EVERYTHING. It runs on what Harvey WRITES AS PROSE
 * — task titles and bodies, job reports. It deliberately does not run on
 * workspace files, because a `.csv` or `.json` may hold an em dash inside a real
 * data value (a property description, a lead's note) and rewriting that would be
 * corrupting data, not fixing style. It also does not run on text a human typed:
 * Carlos writes em dashes, and silently editing his words would be a worse bug
 * than the one being fixed.
 */

/* Figure dash, en dash, em dash, horizontal bar. All four read the same way on
   screen and all four are the tell. Written as escapes on purpose: these
   characters are invisible in a diff, and this is the one file where being able
   to see exactly which of them is handled matters. */
const DASHES = "\\u2012\\u2013\\u2014\\u2015";
/* A run must START with a real dash (so "6-8" and "follow-up" are never
   touched) but may then swallow adjacent ASCII hyphens, because the typo
   people actually produce is "—-" and leaving the stray hyphen behind just
   swaps one odd mark for another. */
const DASH_RUN = new RegExp(`[ \\t]*[${DASHES}][${DASHES}\\-]*[ \\t]*`, "g");

/**
 * Marks where a dash was, so the cleanup below can only ever touch text this
 * function itself changed. Without it, "drop the dangling trailing comma" would
 * also drop legitimate trailing commas from lines that never held a dash.
 * U+0000 cannot occur in real prose, and is scrubbed from the input regardless.
 */
const MARK = "\u0000";

/**
 * Remove the typography that marks text as machine-written.
 *
 * Meaning-preserving by construction: it moves punctuation around, never words.
 * Newlines survive — the DM version replaces `[—–]\s*` and so eats the newline
 * after a dash, which is harmless in a one-line SMS and would concertina a
 * multi-line task body into a paragraph.
 */
export function stripAiTypography(text: string): string {
  if (!text) return text;
  let out = text.split(MARK).join("");

  /* Typeset quotes and a real ellipsis character are the other giveaway: they
     come from a text engine, not from someone's keyboard. */
  out = out
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[\u00A0\u2007\u202F]/g, " ");

  /* A dash between digits is a range, not a pause. "6–8" and "2019–2024" are
     meant, and a comma there would be wrong. */
  out = out.replace(new RegExp(`(\\d)[ \\t]*[${DASHES}]+[ \\t]*(\\d)`, "g"), "$1-$2");

  /* A dash opening a line is a bullet. Turning it into a comma would leave a
     list of fragments each starting with ", ". */
  out = out.replace(new RegExp(`^([ \\t]*)[${DASHES}]+[ \\t]+`, "gm"), "$1- ");

  out = out.replace(DASH_RUN, MARK);

  /* The ASCII double hyphen, which is what the model reaches for the moment the
     em dash is banned. Observed in production on the very first job run after
     this rule shipped: "Call these three first -- they have real names",
     "Pete Morales -- (512) 736-6961 -- San Antonio number". It is the same tell
     wearing a different hat, so it gets the same treatment.

     Three things it must not touch, hence the narrow matching:
       - a CLI flag (`--permission`): double hyphen with no space after it, so
         neither branch below fires;
       - a markdown horizontal rule and a table separator row (`|---|---|`),
         which are handled by skipping any line that is only dashes, pipes,
         colons and spaces;
       - a normal hyphenated word, which never has two. */
  out = out
    .split("\n")
    .map((line) =>
      /^[\s|:-]+$/.test(line)
        ? line
        : line
            .replace(/(\s|^)-{2,}(?=\s)/g, `$1${MARK}`)
            .replace(/(\S)-{2,}(?=\S)/g, `$1${MARK}`),
    )
    .join("\n");

  /* A dash at the end of a line or against punctuation was decoration; it wants
     deleting, not replacing, or the line ends on a dangling comma. */
  out = out.replace(new RegExp(`${MARK}(?=\\n|$)`, "g"), "");
  out = out.replace(new RegExp(`${MARK}(?=[.,;:!?)\\]])`, "g"), "");
  /* Everything left was a pause between two thoughts. A comma, per the house
     rule — which also bans the spaced hyphen that would otherwise be the
     obvious swap, because " - " reads just as machine-written. */
  out = out.replace(new RegExp(MARK, "g"), ", ");

  out = out.replace(/,[ \t]*,+/g, ",").replace(/[ \t]+,/g, ",").replace(/[ \t]{2,}/g, " ");
  return out;
}

/**
 * The voice rules, injected into every prompt where Harvey writes for a person
 * to read.
 *
 * Written as "do this" rather than only "never do that": a prompt that is
 * purely a ban list produces text that is stilted in a new way instead of the
 * old one.
 */
export const HARVEY_HOUSE_STYLE = `HOW YOU WRITE (every task, report, note and message a person will read)

Write like someone on Marco's team typing quickly to a colleague who already
knows the business. Plain, specific, unfussy. If a sentence sounds like it was
written to impress, cut it.

PUNCTUATION
Never use an em dash (—) or an en dash (–). Not once. If two thoughts need
joining, use a full stop, a comma, or a colon. This is the single clearest sign
a machine wrote something, and Marco has asked for it to stop.

Do NOT substitute another mark for it. A double hyphen ("first -- they have")
and a spaced hyphen ("word - word") are the SAME tell in a different costume and
are equally banned. The fix is not a different character, it is a different
sentence: rewrite it so no pause-mark is needed at all.
  WRONG: "Pete Morales — (512) 736-6961 — no follow-up on record."
  WRONG: "Pete Morales -- (512) 736-6961 -- no follow-up on record."
  RIGHT: "Pete Morales, (512) 736-6961. No follow-up on record."

Type straight quotes (" and ') and three dots (...), not the typeset versions.

NEVER
- Emoji as status markers (🔥 ✅ 🚀). A task is not a group chat.
- SHOUTING for emphasis: "TOP 10 TO CALL NOW", "they HAVE phones". Say it once,
  in ordinary words, and let the fact carry it.
- Editorialising asides: "good news", "the good news is", "worth noting",
  "here's the thing", "and that's the problem".
- "Not just X, it's Y" and "X isn't just Y, it's Z".
- A third item added for rhythm when two facts said everything.
- Restating the request before answering it.
- A closing line that summarises what you just said.

ALWAYS
- Lead with the fact or the number.
- Say what to do, and who does it.
- In a task, write only what someone needs in order to act on it. A name, a
  number, a reason, a next step.
- Ordinary sentences. A list when the content is genuinely a list.

Test before you write a task: would Carlos read this and know who to call and
why, without skipping a line? If a line survives only because it sounds good,
delete it.`;
