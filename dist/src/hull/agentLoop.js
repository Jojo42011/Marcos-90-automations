"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serializeToolResult = serializeToolResult;
exports.toolResultContent = toolResultContent;
exports.runAgentLoop = runAgentLoop;
exports.extractSentences = extractSentences;
const founderPrompt_js_1 = require("./founderPrompt.js");
const index_js_1 = require("../harvey/index.js");
const modelRouting_js_1 = require("./modelRouting.js");
const approval_js_1 = require("./approval.js");
const index_js_2 = require("./providers/index.js");
const conversation_js_1 = require("./conversation.js");
const standingOrders_js_1 = require("./standingOrders.js");
const retrieval_js_1 = require("./memory/retrieval.js");
const tools_js_1 = require("./tools.js");
const index_js_3 = require("../integrations/gmail/index.js");
const curiosity_js_1 = require("./curiosity.js");
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
function signature(name, input) {
    try {
        // Key order varies between rounds; sort so the same call always matches.
        return `${name}:${JSON.stringify(input, Object.keys(input).sort())}`;
    }
    catch {
        return `${name}:[unserializable]`;
    }
}
function takeImage(result) {
    if (!result || typeof result !== "object" || Array.isArray(result))
        return { rest: result, image: null };
    const obj = result;
    const raw = obj._image;
    if (!raw || typeof raw.data !== "string" || !raw.data)
        return { rest: result, image: null };
    const { _image, ...rest } = obj;
    return { rest, image: { media_type: raw.media_type || "image/jpeg", data: raw.data } };
}
function serializeToolResult(result) {
    const { rest, image } = takeImage(result);
    const payload = image ? { ...rest, screenshot: "[image omitted in this context]" } : rest;
    const str = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    if (str.length <= MAX_TOOL_CHARS)
        return str;
    return str.slice(0, MAX_TOOL_CHARS) + `\n\n[TRUNCATED: ${str.length} chars total]`;
}
/** Tool result content for the model: text, plus the image when there is one. */
function toolResultContent(result) {
    const { rest, image } = takeImage(result);
    if (!image)
        return serializeToolResult(result);
    const text = typeof rest === "string" ? rest : JSON.stringify(rest, null, 2);
    return [
        { type: "text", text: text.slice(0, MAX_TOOL_CHARS) },
        {
            type: "image",
            source: { type: "base64", media_type: image.media_type, data: image.data },
        },
    ];
}
function extractAssistantText(content) {
    const parts = [];
    for (const block of content) {
        if (block.type === "text" && block.text.trim())
            parts.push(block.text.trim());
    }
    return parts.join("\n\n").trim();
}
function stripMarkdownForSpeech(text) {
    return text
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/^#+\s*/gm, "")
        .replace(/^[-•]\s+/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function finalizeSpeech(text, opts, hadToolOnly) {
    let speech = opts.fastMode
        ? text
        : opts.voiceMode
            ? text
            : (0, curiosity_js_1.maybeAppendCuriosityQuestion)(text, hadToolOnly);
    if (opts.voiceMode)
        speech = stripMarkdownForSpeech(speech);
    return speech;
}
async function runAgentLoop(opts) {
    /* Either key is enough now. OpenRouter reaches every model with one
       credential; direct Anthropic remains a complete path on its own. */
    const keys = (0, index_js_2.providerStatus)();
    if (!keys.primary) {
        return {
            speech: "No model provider is configured. Set OPENROUTER_API_KEY (one key, every model) or ANTHROPIC_API_KEY on the server.",
            toolRounds: 0,
            model: "none",
        };
    }
    const timedHistory = opts.timedHistory ?? [];
    /* A pure pleasantry attaches no tools and runs on the fast model — the
       operational prompt half is dead weight on exactly the turns that need to
       feel most human. Anything ambiguous falls through to the full path. */
    const socialTurn = (0, modelRouting_js_1.isSocialTurn)(opts.message);
    const factLimit = opts.fastMode ? 4 : 8;
    /* "What about him?" carries zero retrievable keywords — short or deictic
       messages blend the prior user turns in so retrieval can see the referent. */
    const retrievalQuery = (0, conversation_js_1.buildRetrievalQuery)(opts.message, timedHistory);
    const facts = await (0, retrieval_js_1.searchFacts)(retrievalQuery, factLimit);
    const memoryPacket = (0, retrieval_js_1.getMemoryPacket)(retrievalQuery, facts);
    const { confidence, count } = opts.fastMode
        ? { confidence: 1, count: facts.length }
        : await (0, retrieval_js_1.getRetrievalConfidence)(opts.message);
    const businessSpecific = !opts.fastMode &&
        !opts.voiceMode &&
        /\b(lead|client|deal|listing|marco|tiktok|mojo|brivity|canyon|price|funnel)\b/i.test(opts.message);
    if (!opts.voiceMode && confidence < 0.15 && count < 3 && businessSpecific) {
        /* A one-line clarification is the cheapest thing Harvey ever does, so it
           runs on the `classify` slot rather than whatever the chat is set to. */
        const clar = await (0, index_js_2.complete)({
            job: "classify",
            sessionId: opts.sessionId,
            maxTokens: 200,
            messages: [
                {
                    role: "user",
                    content: `Marco asked: "${opts.message}" but memory has low confidence. Generate ONE targeted clarification question. No preamble.`,
                },
            ],
        });
        return {
            speech: clar.text,
            toolRounds: 0,
            model: clar.resolved.model,
            modelUsed: clar.modelUsed,
            costUsd: clar.usage.costUsd,
            promptTokens: clar.usage.promptTokens,
            completionTokens: clar.usage.completionTokens,
            clarification: true,
        };
    }
    /* Tool gating is decided BEFORE the prompt is built, because the prompt's
       operational half only attaches when tools do (CORE/OPERATIONAL split). */
    /* The DEEP/FAST decision is unchanged — same triggers, same precedence. What
       changed is only who runs it: `job` names a routing slot the operator can
       repoint at any model, while `model` stays the legacy id so tool gating and
       the existing logs read exactly as before. */
    const wantsDeep = !socialTurn &&
        (Boolean(opts.fullMode) || (!opts.fastMode && !opts.voiceMode && (0, modelRouting_js_1.needsSonnet)(opts.message)));
    const job = opts.job ?? (wantsDeep ? "chat_deep" : "chat_fast");
    const model = wantsDeep ? (0, modelRouting_js_1.getAethonModel)() : (0, modelRouting_js_1.getHaikuModel)();
    const messages = [...(opts.history || []), { role: "user", content: opts.message }];
    const hullTools = (0, tools_js_1.getHullToolDefinitions)({ whatsappSend: opts.ownerMode });
    const sonnetTools = !opts.fastMode && wantsDeep;
    const ownerWhatsAppTools = opts.fastMode && opts.ownerMode;
    const voiceTools = Boolean(opts.voiceMode) && !opts.fastMode;
    const emailIntent = (0, index_js_3.isGmailConfigured)() &&
        /\b(send|email|e-mail|mail)\b/i.test(opts.message) &&
        /\b(email|e-mail|mail|inbox|gmail|me|marco)\b/i.test(opts.message);
    const nurtureIntent = /\b(nurture|scoring|score|hot lead|warm lead|cold lead|lead nurture|re-score|rescore)\b/i.test(opts.message);
    const gmailTools = (0, index_js_3.isGmailConfigured)() &&
        (sonnetTools || ownerWhatsAppTools || voiceTools || emailIntent || opts.ownerMode);
    const nurtureTools = sonnetTools || ownerWhatsAppTools || voiceTools || nurtureIntent || opts.ownerMode;
    const toolsEnabled = !socialTurn &&
        (Boolean(opts.fullMode) || sonnetTools || ownerWhatsAppTools || voiceTools || gmailTools || nurtureTools);
    let system = (0, founderPrompt_js_1.buildFounderSystemPrompt)(memoryPacket, {
        hasTools: toolsEnabled,
        voiceMode: opts.voiceMode,
        conversationState: (0, conversation_js_1.buildConversationState)(timedHistory),
        conversationSummary: opts.sessionId ? (0, conversation_js_1.getConversationSummary)(opts.sessionId) : "",
        standingOrders: (0, standingOrders_js_1.standingOrderRules)(),
    });
    if (toolsEnabled)
        system += `\n\n${index_js_1.HARVEY_CONTENT_MANAGER_SYSTEM_PROMPT}`;
    if (opts.voiceMode) {
        system +=
            "\n\nVOICE MODE: Spoken replies only. Lead with the number or answer. For lead counts, TikTok stats, tasks, or pipeline questions, call the matching tool first instead of guessing. If the utterance is incomplete, ask one short clarifying question.";
        if (toolsEnabled && (0, index_js_3.isGmailConfigured)()) {
            system +=
                "\n\nEMAIL: When Marco asks you to send an email, you MUST call gmail_send first. Use to=\"marco\" for his inbox. NEVER confirm sent unless gmail_send returned ok:true with messageId.";
        }
    }
    else if (opts.fastMode) {
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
    const maxTokens = opts.fastMode ? 512 : opts.voiceMode ? 320 : (0, modelRouting_js_1.getMaxTokens)();
    let toolRounds = 0;
    let hadToolOnly = false;
    /* How many times each identical call has been made this turn. */
    const callCounts = new Map();
    /* Calls held by the gate. The turn still finishes; these did not run. */
    const heldApprovals = [];
    /* Spend accumulates across every step, because one turn can be sixteen calls
       and the per-call number is not what anybody wants to know. */
    let costUsd = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let lastPlan;
    let lastModelUsed = model;
    const stepBudget = opts.fastMode || opts.voiceMode ? MAX_AGENT_STEPS_FAST : MAX_AGENT_STEPS;
    /**
     * Run one tool call, refusing an identical repeat.
     *
     * A refusal returns a RESULT, not an error — the model gets told plainly
     * that it already has this data and should answer from it, which is what
     * breaks the circle. Re-executing would also re-pay the latency (an MLS
     * search or a browser read is seconds) for information already in context.
     */
    const runTool = async (name, input) => {
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
        /* THE GATE. Anything that reaches a real person, spends money or cannot be
           undone stops here and waits for a human, and the model is told plainly
           that it did not run. This is in front of the executor rather than in the
           prompt because a model that misreads the instruction sends the email
           anyway, and there is no undo on a sent email.
    
           A scheduled run passes `approvalMode: "on"` so an unattended task cannot
           inherit a relaxed environment setting. */
        const gated = opts.approvalMode === "on" ? true : (0, approval_js_1.needsApproval)(name, input);
        if (gated) {
            const approval = (0, approval_js_1.requestApproval)({ tool: name, args: input, sessionId: opts.sessionId ?? null });
            heldApprovals.push(approval);
            opts.onEvent?.({ type: "approval", approval });
            return { held_for_approval: true, detail: (0, approval_js_1.heldToolResultText)(approval) };
        }
        opts.onEvent?.({ type: "tool", name, status: "running" });
        try {
            const result = await (0, tools_js_1.executeHullTool)(name, input);
            opts.onEvent?.({ type: "tool", name, status: "done" });
            return result;
        }
        catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            opts.onEvent?.({ type: "tool", name, status: "error", detail });
            return { error: detail };
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
        let out;
        try {
            out = await (0, index_js_2.complete)({
                job,
                modelOverride: opts.modelOverride,
                system: stepSystem,
                messages,
                tools: stepTools,
                maxTokens,
                sessionId: opts.sessionId,
                onToken: opts.onToken,
                /* The ceiling is for the WHOLE turn, so each step is offered only what
                   is left of it. Sixteen steps each allowed the full budget would be
                   sixteen times the number the operator set. */
                maxCostUsd: opts.maxCostUsd !== undefined ? Math.max(0, opts.maxCostUsd - costUsd) : undefined,
            });
        }
        catch (err) {
            /* Two failures worth telling apart. The cap is a decision this system
               made and can be raised; everything else is an outage. Both end the turn
               with a sentence rather than an exception reaching the transport. */
            if (err instanceof index_js_2.BudgetRefusedError) {
                const reason = err.verdict.reason || "The AI spend cap has been reached.";
                return {
                    speech: toolRounds > 0
                        ? `I had to stop partway: ${reason}`
                        : reason,
                    toolRounds,
                    model,
                    modelUsed: lastModelUsed,
                    costUsd,
                    promptTokens,
                    completionTokens,
                    contextPlan: lastPlan,
                    approvals: heldApprovals,
                    budgetRefused: reason,
                };
            }
            const detail = err instanceof index_js_2.ModelLayerError ? err.summary : err instanceof Error ? err.message : String(err);
            console.error("[agentLoop] model call failed:", detail);
            return {
                speech: `I could not reach a model just now. ${detail}`,
                toolRounds,
                model,
                modelUsed: lastModelUsed,
                costUsd,
                promptTokens,
                completionTokens,
                contextPlan: lastPlan,
                approvals: heldApprovals,
                modelError: detail,
            };
        }
        costUsd += out.usage.costUsd;
        promptTokens += out.usage.promptTokens;
        completionTokens += out.usage.completionTokens;
        lastPlan = out.contextPlan;
        lastModelUsed = out.modelUsed;
        opts.onEvent?.({
            type: "usage",
            model: out.modelUsed,
            promptTokens: out.usage.promptTokens,
            completionTokens: out.usage.completionTokens,
            costUsd: out.usage.costUsd,
        });
        if (!out.toolUses.length) {
            return {
                speech: finalizeSpeech(out.text, opts, hadToolOnly),
                toolRounds,
                model,
                modelUsed: out.modelUsed,
                costUsd,
                promptTokens,
                completionTokens,
                contextPlan: out.contextPlan,
                approvals: heldApprovals,
            };
        }
        hadToolOnly = !out.text.trim();
        const toolResults = await Promise.all(out.toolUses.map(async (tu) => ({
            type: "tool_result",
            tool_use_id: tu.id,
            content: toolResultContent(await runTool(tu.name, tu.input || {})),
        })));
        /* Rebuild the assistant turn in Anthropic's block shape. The tool loop
           requires the tool_use blocks to be echoed back verbatim alongside their
           results, whichever provider actually produced them. */
        const assistantContent = [];
        if (out.text.trim())
            assistantContent.push({ type: "text", text: out.text });
        for (const tu of out.toolUses) {
            assistantContent.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
        }
        messages.push({ role: "assistant", content: assistantContent });
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
        modelUsed: lastModelUsed,
        costUsd,
        promptTokens,
        completionTokens,
        contextPlan: lastPlan,
        approvals: heldApprovals,
    };
}
function extractSentences(buffer) {
    const sentences = [];
    let rest = buffer;
    const re = /([^.!?]+[.!?]+)\s*/g;
    let m;
    while ((m = re.exec(rest)) !== null) {
        const s = m[1].trim();
        if (s.length > 2)
            sentences.push(s);
    }
    const lastEnd = rest.lastIndexOf(".") > rest.lastIndexOf("!")
        ? Math.max(rest.lastIndexOf("."), rest.lastIndexOf("!"), rest.lastIndexOf("?"))
        : Math.max(rest.lastIndexOf("!"), rest.lastIndexOf("?"));
    if (lastEnd >= 0)
        rest = rest.slice(lastEnd + 1);
    else if (sentences.length)
        rest = "";
    return { sentences, remainder: rest };
}
