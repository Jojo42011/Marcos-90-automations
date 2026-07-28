/**
 * 3.3 — AI suggested replies.
 *
 * Drafts what to say next to a contact, reading the **whole record**, not just
 * the last message: every message in the thread, plus criteria, intent,
 * pipeline stage, source, property inquired about, CRM notes, tags and recent
 * activity. The spec is explicit that the last message alone is not enough,
 * and it's right — "yes that works" means nothing without the six messages
 * before it.
 *
 * Two shapes, one context builder:
 *   - `suggestReply()`   — a full draft the user accepts, edits, or ignores.
 *   - `completeReply()`  — finishes the sentence being typed (inline ghost
 *                          text). Same context, much tighter instruction.
 *
 * Deliberately a suggestion and never an action: nothing here sends anything.
 * The draft lands in the composer where a human decides. Given this text goes
 * to real clients, that boundary matters more than the convenience of
 * auto-sending.
 */
import type { Lead, Message } from "./types.js";
import { getConversation } from "./db.js";
import { complete } from "../integrations/llm/index.js";

export interface SuggestOptions {
  /** "sms" keeps it short; "email" allows structure. */
  channel?: "sms" | "email";
  /** What the user has typed so far, for the inline completion path. */
  draft?: string;
}

export interface ReplySuggestion {
  suggestion: string;
  /** One line on why — shown under the draft so it isn't a black box. */
  rationale?: string;
  /** How much of the record was actually available to reason from. */
  basedOn: { messages: number; hasCriteria: boolean; hasNotes: boolean; stage: string };
}

const MAX_MESSAGES = 40;

function fmtCriteria(lead: Lead): string {
  const c = lead.criteria;
  if (!c) return "";
  const bits: string[] = [];
  if (c.priceCap != null) bits.push(`Budget up to $${c.priceCap.toLocaleString()}`);
  if (c.beds != null) bits.push(`${c.beds} bed`);
  if (c.baths != null) bits.push(`${c.baths} bath`);
  if (c.area) bits.push(`Area: ${c.area}`);
  if (c.timeline) bits.push(`Timeline: ${c.timeline}`);
  return bits.join(" | ");
}

/** Everything known about this person, as plain text for the model. */
export function buildLeadContext(lead: Lead, messages: Message[]): string {
  const lines: string[] = [];
  const name = lead.name || lead.username || "Unknown";

  lines.push(`CONTACT: ${name}`);
  if (lead.platform) lines.push(`Channel: ${lead.platform}`);
  if (lead.source) lines.push(`Source: ${lead.source}`);
  if (lead.crmIntent) lines.push(`Intent: ${lead.crmIntent}`);
  if (lead.crmStage) lines.push(`Pipeline stage: ${lead.crmStage}`);
  if (lead.crmStatus) lines.push(`Status: ${lead.crmStatus}`);
  if (lead.state) lines.push(`Funnel state: ${lead.state}`);
  if (lead.propertyInquired) lines.push(`Property they asked about: ${lead.propertyInquired}`);
  if (lead.adCampaign) lines.push(`Came from campaign: ${lead.adCampaign}`);

  const crit = fmtCriteria(lead);
  if (crit) lines.push(`What they're looking for: ${crit}`);

  if (Array.isArray(lead.tags) && lead.tags.length) lines.push(`Tags: ${lead.tags.join(", ")}`);
  if (lead.crmNotes) lines.push(`Notes on file: ${String(lead.crmNotes).slice(0, 800)}`);

  if (Array.isArray(lead.activity) && lead.activity.length) {
    const recent = lead.activity.slice(-6).map((a) => {
      const at = a.timestamp ? String(a.timestamp).slice(0, 10) : "";
      const note = a.notes ? ` (${String(a.notes).slice(0, 120)})` : "";
      return `- ${at} ${a.type}: ${String(a.description || "").slice(0, 140)}${note}`;
    });
    lines.push(`Recent activity:\n${recent.join("\n")}`);
  }

  if (lead.lastActivity) lines.push(`Last activity: ${lead.lastActivity}`);

  const convo = messages.slice(-MAX_MESSAGES);
  if (convo.length) {
    lines.push(
      `\nFULL CONVERSATION (${messages.length} message${messages.length === 1 ? "" : "s"}${
        messages.length > MAX_MESSAGES ? `, showing the last ${MAX_MESSAGES}` : ""
      }, oldest first):`,
    );
    for (const m of convo) {
      const who = m.role === "assistant" ? "Marco" : name;
      const at = m.at ? ` (${String(m.at).slice(0, 16).replace("T", " ")})` : "";
      lines.push(`${who}${at}: ${m.text}`);
    }
  } else {
    lines.push("\nFULL CONVERSATION: none yet — this would be the first message.");
  }

  return lines.join("\n");
}

const VOICE = `You are drafting on behalf of Marco Puga, a San Antonio real-estate agent.
His voice: warm, direct, concrete. Short sentences. No corporate filler, no
"I hope this message finds you well", no emoji unless the contact used them
first. He moves conversations forward by asking one specific question or
proposing one specific next step.`;

const GROUNDING = `Rules:
- Use ONLY facts present in the record below. Never invent an address, price,
  appointment, MLS number, or anything you were not given.
- If the record does not contain enough to say something useful, ask the one
  question that would unblock the conversation.
- Do not promise anything Marco has not already offered.
- Reference what they actually said earlier when it's relevant — that is the
  point of reading the whole thread.`;

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Context for a thread with no CRM record behind it.
 *
 * Some conversations aren't linked to a lead — group threads, and anything
 * still showing from the demo set. Refusing to draft for those was wrong:
 * the conversation is right there on screen, and it is the single most
 * useful input. This is the degraded path — thread only, no criteria or
 * notes — and `basedOn` reports exactly that, so the panel never implies it
 * read a record it didn't have.
 */
export function buildThreadContext(contactName: string, messages: Message[]): string {
  const name = contactName || "the contact";
  const lines = [`CONTACT: ${name}`, "(No CRM record linked — working from the conversation alone.)"];
  const convo = messages.slice(-MAX_MESSAGES);
  if (convo.length) {
    lines.push(`\nFULL CONVERSATION (${messages.length} message${messages.length === 1 ? "" : "s"}, oldest first):`);
    for (const m of convo) {
      const who = m.role === "assistant" ? "Marco" : name;
      const at = m.at ? ` (${String(m.at).slice(0, 16).replace("T", " ")})` : "";
      lines.push(`${who}${at}: ${m.text}`);
    }
  } else {
    lines.push("\nFULL CONVERSATION: none yet.");
  }
  return lines.join("\n");
}

/** Shared drafting step, so both paths produce identical shapes. */
async function draftFrom(
  context: string,
  channel: "sms" | "email",
  draft: string | undefined,
  basedOn: ReplySuggestion["basedOn"],
): Promise<ReplySuggestion> {
  const lengthRule =
    channel === "sms"
      ? "This is a TEXT MESSAGE. One or two sentences, under 320 characters. No greeting line, no sign-off."
      : "This is an EMAIL. Up to a short paragraph or two. No subject line, no sign-off — Marco adds those.";

  const draftNote = draft?.trim()
    ? `\n\nMarco has already started typing: "${draft.trim()}". Finish that thought in his voice rather than starting over.`
    : "";

  const prompt = `${VOICE}

${GROUNDING}

${lengthRule}${draftNote}

Write the reply Marco should send next. Return ONLY JSON:
{"reply": "<the message>", "why": "<one short line on why this is the right next move>"}`;

  const raw = await complete(prompt, context);

  let suggestion = "";
  let rationale: string | undefined;
  try {
    const match = /\{[\s\S]*\}/.exec(raw);
    if (match) {
      const parsed = JSON.parse(match[0]) as { reply?: string; why?: string };
      suggestion = String(parsed.reply || "").trim();
      rationale = parsed.why ? String(parsed.why).trim() : undefined;
    }
  } catch {
    // Fall through to the raw text below.
  }
  // A model that ignored the JSON envelope still produced a usable draft;
  // throwing it away would be worse than showing it.
  if (!suggestion) suggestion = stripQuotes(raw);

  return { suggestion, rationale, basedOn };
}

/** Draft for a thread with no linked lead. */
export async function suggestReplyFromThread(
  contactName: string,
  messages: Message[],
  opts: SuggestOptions = {},
): Promise<ReplySuggestion> {
  return draftFrom(
    buildThreadContext(contactName, messages),
    opts.channel === "email" ? "email" : "sms",
    opts.draft,
    { messages: messages.length, hasCriteria: false, hasNotes: false, stage: "unlinked" },
  );
}

/** Finish the sentence for a thread with no linked lead. */
export async function completeReplyFromThread(
  contactName: string,
  messages: Message[],
  draft: string,
  opts: SuggestOptions = {},
): Promise<string> {
  return completeFrom(buildThreadContext(contactName, messages), draft, opts);
}

/** A full reply to accept, edit, or ignore. Uses the contact's whole record. */
export async function suggestReply(lead: Lead, opts: SuggestOptions = {}): Promise<ReplySuggestion> {
  const conversation = await getConversation(lead.id);
  const messages = conversation?.messages || [];
  return draftFrom(
    buildLeadContext(lead, messages),
    opts.channel === "email" ? "email" : "sms",
    opts.draft,
    {
      messages: messages.length,
      hasCriteria: Boolean(fmtCriteria(lead)),
      hasNotes: Boolean(lead.crmNotes),
      stage: lead.crmStage || lead.state || "unknown",
    },
  );
}

/** Shared sentence-completion step. Returns only the CONTINUATION. */
async function completeFrom(context: string, draft: string, opts: SuggestOptions): Promise<string> {
  const typed = draft.trim();
  // Too little to predict from — a completion off two characters is noise.
  if (typed.length < 8) return "";

  const prompt = `${VOICE}

${GROUNDING}

Marco is typing a ${opts.channel === "email" ? "email" : "text"} and has written:
"${typed}"

Continue it — return ONLY the text that should come AFTER what he typed, so it
reads naturally when appended. Do not repeat any of his words. Finish the
current sentence and at most one more. If you cannot continue it sensibly,
return an empty string. Return plain text only, no quotes, no JSON.`;

  const raw = (await complete(prompt, context)).trim();
  let out = stripQuotes(raw);

  // Guard against the model echoing the draft back — appending that would
  // duplicate what the user already typed.
  if (out.toLowerCase().startsWith(typed.toLowerCase())) out = out.slice(typed.length);
  // A "completion" longer than a couple of sentences is a rewrite, not a
  // prediction, and is jarring as ghost text.
  if (out.length > 220) out = out.slice(0, 220);
  return out.trim();
}

/**
 * Inline predictive text for a linked lead: finish the sentence in progress,
 * with the whole record available.
 */
export async function completeReply(lead: Lead, draft: string, opts: SuggestOptions = {}): Promise<string> {
  if (draft.trim().length < 8) return "";
  const conversation = await getConversation(lead.id);
  return completeFrom(buildLeadContext(lead, conversation?.messages || []), draft, opts);
}
