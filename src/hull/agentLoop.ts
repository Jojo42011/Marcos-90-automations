import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { buildFounderSystemPrompt } from "./founderPrompt.js";
import { HARVEY_CONTENT_MANAGER_SYSTEM_PROMPT } from "../harvey/index.js";
import { getAethonModel, getHaikuModel, getMaxTokens, isSocialTurn, needsSonnet } from "./modelRouting.js";
import {
  buildConversationState,
  buildRetrievalQuery,
  getConversationSummary,
  type TimedTurn,
} from "./conversation.js";
import { standingOrderRules } from "./standingOrders.js";
import { searchFacts, getMemoryPacket, getRetrievalConfidence } from "./memory/retrieval.js";
import { getHullToolDefinitions, executeHullTool } from "./tools.js";
import { isGmailConfigured } from "../integrations/gmail/index.js";
import { maybeAppendCuriosityQuestion } from "./curiosity.js";

/**
 * Tool-round budget.
 *
 * WHY THIS WAS HIT, AND WHY RAISING IT ALONE WOULD NOT HAVE FIXED IT.
 * The old budget was a flat 8 rounds and running out produced
 * "Hit the tool loop limit — try a narrower question." — which threw away
 * every fact gathered on the way and handed Marco nothing. Three things
 * conspired:
 *   1. Real questions genuinely need more than 8 rounds now. Since MLS landed,
 *      "what's moving in Boerne under 600" is a listing search, then a per-
 *      listing read, then a CRM cross-check: each is its own round, and web
 *      research spends 2-3 before it has even read a page.
 *   2. The model re-called the SAME tool with the SAME arguments when a result
 *      came back thin or empty — a genuine loop, burning the budget without
 *      new information (see `signature` below).
 *   3. Exhaustion was a dead end rather than a deadline. Nothing told the model
 *      it was running out, so it never wound up.
 *
 * The fix is all three: a bigger, mode-aware budget; identical repeat calls
 * refused with a nudge instead of re-executed; and the LAST round always runs
 * with tools withheld, so the budget ends in an answer built from what was
 * actually gathered rather than an apology.
 */
const MAX_AGENT_STEPS = 16;
/** Voice and WhatsApp answer in 1-3 sentences and a human is waiting on the
 *  line — a long tool chain there is a silence, not a better answer. */
const MAX_AGENT_STEPS_FAST = 8;
/** How many times an identical call is allowed before it is refused. Two, not
 *  one: a legitimate retry after a transient failure is real. */
const MAX_IDENTICAL_CALLS = 2;
const MAX_TOOL_CHARS = 12000;

/** Identity of a tool call, for spotting a model going in circles. */
function signature(name: string, input: Record<string, unknown>): string {
  try {
    // Key order varies between rounds; sort so the same call always matches.
    return `${name}:${JSON.stringify(input, Object.keys(input).sort())}`;
  } catch {
    return `${name}:[unserializable]`;
  }
}

/**
 * A tool can hand back a picture as well as text.
 *
 * The convention is a `_image: { media_type, data }` key on the result object.
 * It exists for browser_screenshot: some pages only make sense visually — a map
 * of comps, a scanned disclosure, a layout where the price is inside an image —
 * and no amount of DOM reading recovers that.
 *
 * `_image` is stripped everywhere the result is flattened to a string, so a
 * few hundred KB of base64 can never leak into a log line, an audit trail, or
 * a code path that only expected text.
 */
interface ToolImage { media_type: string; data: string }

function takeImage(result: unknown): { rest: unknown; image: ToolImage | null } {
  if (!result || typeof result !== "object" || Array.isArray(result)) return { rest: result, image: null };
  const obj = result as Record<string, unknown>;
  const raw = obj._image as ToolImage | undefined;
  if (!raw || typeof raw.data !== "string" || !raw.data) return { rest: result, image: null };
  const { _image, ...rest } = obj;
  return { rest, image: { media_type: raw.media_type || "image/jpeg", data: raw.data } };
}

export function serializeToolResult(result: unknown): string {
  const { rest, image } = takeImage(result);
  const payload = image ? { ...(rest as object), screenshot: "[image omitted in this context]" } : rest;
  const str = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  if (str.length <= MAX_TOOL_CHARS) return str;
  return str.slice(0, MAX_TOOL_CHARS) + `\n\n[TRUNCATED: ${str.length} chars total]`;
}

/** Tool result content for the model: text, plus the image when there is one. */
export function toolResultContent(
  result: unknown,
): string | Array<Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam> {
  const { rest, image } = takeImage(result);
  if (!image) return serializeToolResult(result);
  const text = typeof rest === "string" ? rest : JSON.stringify(rest, null, 2);
  return [
    { type: "text", text: text.slice(0, MAX_TOOL_CHARS) },
    {
      type: "image",
      source: { type: "base64", media_type: image.media_type as "image/jpeg" | "image/png", data: image.data },
    },
  ];
}

function extractAssistantText(content: Anthropic.Messages.Message["content"]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text.trim()) parts.push(block.text.trim());
  }
  return parts.join("\n\n").trim();
}

export interface AgentLoopResult {
  speech: string;
  toolRounds: number;
  model: string;
  clarification?: boolean;
}

export interface AgentLoopOptions {
  message: string;
  history?: MessageParam[];
  /** Timestamped turns for the continuity layer (conversation state, deictic
   *  retrieval). Same content as history, plus `at`. */
  timedHistory?: TimedTurn[];
  /** Session id — keys the rolling "conversation so far" summary. */
  sessionId?: string;
  voiceMode?: boolean;
  /** Low-latency path (WhatsApp): Haiku, short replies. */
  fastMode?: boolean;
  /** Marco self-chat — enables whatsapp_send for delegated outbound messages. */
  ownerMode?: boolean;
  /** Per-contact context line (e.g. Jahan DM). */
  channelContext?: string;
  /** Force the smartest path: Sonnet + every business/memory tool, regardless
   *  of keyword triggers — used by the dedicated Harvey chat so it always has
   *  full knowledge of the system (leads, finance, DMs, content, memory…). */
  fullMode?: boolean;
  onToken?: (token: string) => void;
}

function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/^[-•]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function finalizeSpeech(text: string, opts: AgentLoopOptions, hadToolOnly: boolean): string {
  let speech = opts.fastMode
    ? text
    : opts.voiceMode
      ? text
      : maybeAppendCuriosityQuestion(text, hadToolOnly);
  if (opts.voiceMode) speech = stripMarkdownForSpeech(speech);
  return speech;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    return {
      speech: "Anthropic API key not configured.",
      toolRounds: 0,
      model: "none",
    };
  }

  const client = new Anthropic({ apiKey: key });
  const timedHistory = opts.timedHistory ?? [];
  /* A pure pleasantry attaches no tools and runs on the fast model — the
     operational prompt half is dead weight on exactly the turns that need to
     feel most human. Anything ambiguous falls through to the full path. */
  const socialTurn = isSocialTurn(opts.message);
  const factLimit = opts.fastMode ? 4 : 8;
  /* "What about him?" carries zero retrievable keywords — short or deictic
     messages blend the prior user turns in so retrieval can see the referent. */
  const retrievalQuery = buildRetrievalQuery(opts.message, timedHistory);
  const facts = await searchFacts(retrievalQuery, factLimit);
  const memoryPacket = getMemoryPacket(retrievalQuery, facts);
  const { confidence, count } = opts.fastMode
    ? { confidence: 1, count: facts.length }
    : await getRetrievalConfidence(opts.message);

  const businessSpecific =
    !opts.fastMode &&
    !opts.voiceMode &&
    /\b(lead|client|deal|listing|marco|tiktok|mojo|brivity|canyon|price|funnel)\b/i.test(opts.message);

  if (!opts.voiceMode && confidence < 0.15 && count < 3 && businessSpecific) {
    const clar = await client.messages.create({
      model: getHaikuModel(),
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `Marco asked: "${opts.message}" but memory has low confidence. Generate ONE targeted clarification question. No preamble.`,
        },
      ],
    });
    const q = extractAssistantText(clar.content);
    return { speech: q, toolRounds: 0, model: getHaikuModel(), clarification: true };
  }

  /* Tool gating is decided BEFORE the prompt is built, because the prompt's
     operational half only attaches when tools do (CORE/OPERATIONAL split). */
  const model = socialTurn
    ? getHaikuModel()
    : opts.fullMode
    ? getAethonModel()
    : opts.fastMode
    ? getHaikuModel()
    : opts.voiceMode
      ? getHaikuModel()
      : needsSonnet(opts.message)
        ? getAethonModel()
        : getHaikuModel();
  const messages: MessageParam[] = [...(opts.history || []), { role: "user", content: opts.message }];
  const hullTools = getHullToolDefinitions({ whatsappSend: opts.ownerMode });
  const sonnetTools = !opts.fastMode && model === getAethonModel();
  const ownerWhatsAppTools = opts.fastMode && opts.ownerMode;
  const voiceTools = Boolean(opts.voiceMode) && !opts.fastMode;
  const emailIntent =
    isGmailConfigured() &&
    /\b(send|email|e-mail|mail)\b/i.test(opts.message) &&
    /\b(email|e-mail|mail|inbox|gmail|me|marco)\b/i.test(opts.message);
  const nurtureIntent =
    /\b(nurture|scoring|score|hot lead|warm lead|cold lead|lead nurture|re-score|rescore)\b/i.test(
      opts.message,
    );
  const gmailTools =
    isGmailConfigured() &&
    (sonnetTools || ownerWhatsAppTools || voiceTools || emailIntent || opts.ownerMode);
  const nurtureTools =
    sonnetTools || ownerWhatsAppTools || voiceTools || nurtureIntent || opts.ownerMode;
  const toolsEnabled =
    !socialTurn &&
    (Boolean(opts.fullMode) || sonnetTools || ownerWhatsAppTools || voiceTools || gmailTools || nurtureTools);

  let system = buildFounderSystemPrompt(memoryPacket, {
    hasTools: toolsEnabled,
    voiceMode: opts.voiceMode,
    conversationState: buildConversationState(timedHistory),
    conversationSummary: opts.sessionId ? getConversationSummary(opts.sessionId) : "",
    standingOrders: standingOrderRules(),
  });
  if (toolsEnabled) system += `\n\n${HARVEY_CONTENT_MANAGER_SYSTEM_PROMPT}`;
  if (opts.voiceMode) {
    system +=
      "\n\nVOICE MODE: Spoken replies only. Lead with the number or answer. For lead counts, TikTok stats, tasks, or pipeline questions, call the matching tool first instead of guessing. If the utterance is incomplete, ask one short clarifying question.";
    if (toolsEnabled && isGmailConfigured()) {
      system +=
        "\n\nEMAIL: When Marco asks you to send an email, you MUST call gmail_send first. Use to=\"marco\" for his inbox. NEVER confirm sent unless gmail_send returned ok:true with messageId.";
    }
  } else if (opts.fastMode) {
    system +=
      "\n\nWHATSAPP MODE: Reply in 1-3 short sentences. No markdown. Be direct and conversational.";
    if (opts.ownerMode) {
      system +=
        "\n\nWhen Marco asks you to text/send someone on WhatsApp, call whatsapp_send with the contact name or number and exact message. Confirm briefly after sending.";
    }
    if (opts.channelContext) {
      system += `\n\n${opts.channelContext}`;
    }
  }
  if (toolsEnabled && gmailTools) {
    system +=
      "\n\nEMAIL: When Marco asks you to send an email, you MUST call gmail_send with recipient, subject, and body before replying. For Marco's inbox use to=\"marco\" or his full email if you know it. NEVER say an email was sent unless gmail_send returned ok:true with a messageId — if the tool returns error, report that error to Marco.";
  }
  if (toolsEnabled && nurtureTools) {
    system +=
      "\n\nLEAD NURTURE: For scoring, hot/warm/cold tiers, or nurture routing questions, call get_lead_nurture_overview or get_lead_nurture_tier before answering. Use get_lead_score_detail for one lead. Use lead_nurture_score_all / lead_nurture_rescore_cold only when Marco explicitly asks to refresh scores.";
  }
  const activeTools = toolsEnabled ? hullTools : undefined;
  /* Voice turns are 1-3 sentences; a large reserve both wastes budget and
     removes the hard backstop on rambling (playbook §7.5). */
  const maxTokens = opts.fastMode ? 512 : opts.voiceMode ? 320 : getMaxTokens();

  let toolRounds = 0;
  let hadToolOnly = false;
  /* How many times each identical call has been made this turn. */
  const callCounts = new Map<string, number>();

  const stepBudget = opts.fastMode || opts.voiceMode ? MAX_AGENT_STEPS_FAST : MAX_AGENT_STEPS;

  /**
   * Run one tool call, refusing an identical repeat.
   *
   * A refusal returns a RESULT, not an error — the model gets told plainly
   * that it already has this data and should answer from it, which is what
   * breaks the circle. Re-executing would also re-pay the latency (an MLS
   * search or a browser read is seconds) for information already in context.
   */
  const runTool = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    const sig = signature(name, input);
    const seen = (callCounts.get(sig) || 0) + 1;
    callCounts.set(sig, seen);
    if (seen > MAX_IDENTICAL_CALLS) {
      console.warn(`[agentLoop] refused repeat call ${seen}× ${name}`);
      return {
        error: "REPEATED CALL REFUSED",
        detail: `You have already called ${name} with these exact arguments ${seen - 1} times this turn. The answer will not change. Use what you already have, and if it is genuinely empty say so plainly rather than searching again.`,
      };
    }
    try {
      return await executeHullTool(name, input);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  for (let step = 0; step < stepBudget; step++) {
    /* The final round runs with tools WITHHELD. The budget then ends in an
       answer assembled from everything gathered, instead of the dead-end
       "hit the tool loop limit" that discarded the whole turn's work. */
    const lastRound = step === stepBudget - 1;
    const stepTools = lastRound ? undefined : activeTools;
    const stepSystem = lastRound && toolRounds > 0
      ? system +
        "\n\nFINAL ROUND: no more tool calls are available this turn. Answer Marco now using what you already gathered above. If something is genuinely still missing, say which part you could not get and what you would need — do not apologise for the process or mention limits, rounds, or tools."
      : system;

    if (opts.onToken) {
      const stream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        system: stepSystem,
        messages,
        tools: stepTools,
      });

      let full = "";
      const finalMsg = await new Promise<Anthropic.Messages.Message>((resolve, reject) => {
        stream.on("text", (t) => {
          full += t;
          opts.onToken?.(t);
        });
        stream
          .finalMessage()
          .then(resolve)
          .catch(reject);
      });

      if (finalMsg.stop_reason !== "tool_use") {
        const text = full.trim() || extractAssistantText(finalMsg.content);
        return { speech: finalizeSpeech(text, opts, hadToolOnly), toolRounds, model };
      }

      const toolUseBlocks = finalMsg.content.filter((b) => b.type === "tool_use");
      hadToolOnly = toolUseBlocks.length > 0 && !full.trim();
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (tu) => {
          const input =
            tu.input && typeof tu.input === "object" && !Array.isArray(tu.input)
              ? (tu.input as Record<string, unknown>)
              : {};
          return {
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: toolResultContent(await runTool(tu.name, input)),
          };
        }),
      );
      messages.push({ role: "assistant", content: finalMsg.content });
      messages.push({ role: "user", content: toolResults });
      toolRounds++;
      continue;
    }

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: stepSystem,
      messages,
      tools: stepTools,
    });

    if (response.stop_reason !== "tool_use") {
      return {
        speech: finalizeSpeech(extractAssistantText(response.content), opts, hadToolOnly),
        toolRounds,
        model,
      };
    }

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    hadToolOnly = true;
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (tu) => {
        const input =
          tu.input && typeof tu.input === "object" && !Array.isArray(tu.input)
            ? (tu.input as Record<string, unknown>)
            : {};
        return {
          type: "tool_result" as const,
          tool_use_id: tu.id,
          content: toolResultContent(await runTool(tu.name, input)),
        };
      }),
    );
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
    toolRounds++;
  }

  /* Unreachable in practice: the final round withholds tools, so the loop
     always exits through a text answer above. Kept as a last-resort guard
     rather than deleted — if a future change reintroduces a path that falls
     out here, an honest sentence beats an undefined. */
  return {
    speech: "I ran out of room to keep digging on that one. Ask me for the specific piece you need and I'll go straight at it.",
    toolRounds,
    model,
  };
}

export function extractSentences(buffer: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let rest = buffer;
  const re = /([^.!?]+[.!?]+)\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const s = m[1].trim();
    if (s.length > 2) sentences.push(s);
  }
  const lastEnd = rest.lastIndexOf(".") > rest.lastIndexOf("!")
    ? Math.max(rest.lastIndexOf("."), rest.lastIndexOf("!"), rest.lastIndexOf("?"))
    : Math.max(rest.lastIndexOf("!"), rest.lastIndexOf("?"));
  if (lastEnd >= 0) rest = rest.slice(lastEnd + 1);
  else if (sentences.length) rest = "";
  return { sentences, remainder: rest };
}
