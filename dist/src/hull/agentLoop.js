"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serializeToolResult = serializeToolResult;
exports.toolResultContent = toolResultContent;
exports.runAgentLoop = runAgentLoop;
exports.extractSentences = extractSentences;
const execution_js_1 = require("../harvey/work/execution.js");
const reliability_js_1 = require("../harvey/reliability.js");
const founderPrompt_js_1 = require("./founderPrompt.js");
const modelRouting_js_1 = require("./modelRouting.js");
const approval_js_1 = require("./approval.js");
const index_js_1 = require("./providers/index.js");
const conversation_js_1 = require("./conversation.js");
const standingOrders_js_1 = require("./standingOrders.js");
const retrieval_js_1 = require("./memory/retrieval.js");
const tools_js_1 = require("./tools.js");
const index_js_2 = require("../integrations/gmail/index.js");
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
    return (0, reliability_js_1.stableCallKey)(name, input);
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
    let speech = opts.fastMode || opts.workRuntime
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
    const keys = (0, index_js_1.providerStatus)();
    if (!keys.primary) {
        const detail = "No model provider is configured. Set OPENROUTER_API_KEY (one key, every model) or ANTHROPIC_API_KEY on the server.";
        /* `modelError` matters as much as the sentence. Without it an unattended
           caller records a SUCCESSFUL run whose deliverable is this apology, so a
           scheduled task on a keyless server reads healthy in the list and never
           trips the pause — the same trap as the outage path below. */
        return { speech: detail, toolRounds: 0, model: "none", modelError: detail };
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
    const facts = opts.workRuntime ? [] : await (0, retrieval_js_1.searchFacts)(retrievalQuery, factLimit);
    const memoryPacket = opts.workRuntime ? "" : (0, retrieval_js_1.getMemoryPacket)(retrievalQuery, facts);
    const { confidence, count } = opts.fastMode || opts.workRuntime
        ? { confidence: 1, count: facts.length }
        : await (0, retrieval_js_1.getRetrievalConfidence)(opts.message);
    const businessSpecific = !opts.fastMode &&
        !opts.voiceMode &&
        /\b(lead|client|deal|listing|marco|tiktok|mojo|brivity|canyon|price|funnel)\b/i.test(opts.message);
    if (!opts.workRuntime && !opts.voiceMode && confidence < 0.15 && count < 3 && businessSpecific) {
        /* A one-line clarification is the cheapest thing Harvey ever does, so it
           runs on the `classify` slot rather than whatever the chat is set to. */
        const clar = await (0, index_js_1.complete)({
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
    const emailIntent = (0, index_js_2.isGmailConfigured)() &&
        /\b(send|email|e-mail|mail)\b/i.test(opts.message) &&
        /\b(email|e-mail|mail|inbox|gmail|me|marco)\b/i.test(opts.message);
    const nurtureIntent = /\b(nurture|scoring|score|hot lead|warm lead|cold lead|lead nurture|re-score|rescore)\b/i.test(opts.message);
    const gmailTools = (0, index_js_2.isGmailConfigured)() &&
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
    if (opts.voiceMode) {
        system +=
            "\n\nVOICE MODE: Spoken replies only. Lead with the number or answer. For lead counts, TikTok stats, tasks, or pipeline questions, call the matching tool first instead of guessing. If the utterance is incomplete, ask one short clarifying question.";
        if (toolsEnabled && (0, index_js_2.isGmailConfigured)()) {
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
    if (process.env.TENANT_MEMBER)
        system += `

SIGNED-IN ACCOUNT: The current user is ${process.env.TENANT_MEMBER}. This identity overrides historical Marco-specific persona examples. Address this person by their own name. Only use verified data available to this account. ${process.env.TENANT_MEMBER === "carlos" ? "Carlos assists both Marco and Wesley; use crm_api collection endpoints for combined business statistics, never infer totals from personal legacy tools." : "Business records are private to this account; team SOPs and Knowledge Center training are shared."}`;
    if (opts.workRuntime)
        system = opts.workRuntime.context;
    system += "\n\n" + reliability_js_1.RELIABILITY_RULES;
    const verification = new reliability_js_1.TurnVerification();
    const activeTools = opts.workRuntime ? [...opts.workRuntime.tools, reliability_js_1.VERIFICATION_TOOL, reliability_js_1.SOURCE_CHECK_TOOL] : toolsEnabled ? hullTools : undefined;
    /* Voice turns are 1-3 sentences; a large reserve both wastes budget and
       removes the hard backstop on rambling (playbook §7.5). */
    const maxTokens = opts.fastMode ? 512 : opts.voiceMode ? 320 : (0, modelRouting_js_1.getMaxTokens)();
    let toolRounds = 0;
    let completionRepairs = 0;
    let malformedRepairs = 0;
    const videoAttempts = new Map();
    let hadToolOnly = false;
    /* How many times each identical call has been made this turn. */
    const callCounts = new Map();
    let observationRevision = 0;
    let continuation;
    let unfinishedReminders = 0;
    let scrollRecoveryPrompted = false;
    const safeBrowserRetry = new Set();
    /* Calls held by the gate. The turn still finishes; these did not run. */
    const heldApprovals = [];
    /* Spend accumulates across every step, because one turn can be sixteen calls
       and the per-call number is not what anybody wants to know. */
    let costUsd = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let lastPlan;
    let lastModelUsed = model;
    let effectiveJob = job;
    let recoveryModel;
    let formatFallbackUsed = false;
    let emailRecoveryPrompted = false;
    let plainStatusRewrite = false;
    let substituted;
    // A saved interactive task owns its execution lifetime. Tool rounds are not
    // user turns: never remove its tools just because it performed 29 actions.
    const uninterrupted = !!opts.allowContinuation && !!opts.workRuntime;
    const stepBudget = uninterrupted ? Infinity : opts.fastMode || opts.voiceMode ? MAX_AGENT_STEPS_FAST : opts.workRuntime ? 32 : MAX_AGENT_STEPS;
    let idleToolRounds = 0;
    let falseLimitReminders = 0;
    /**
     * Run one tool call, refusing an identical repeat.
     *
     * A refusal returns a RESULT, not an error — the model gets told plainly
     * that it already has this data and should answer from it, which is what
     * breaks the circle. Re-executing would also re-pay the latency (an MLS
     * search or a browser read is seconds) for information already in context.
     */
    const executeTool = async (name, input) => {
        opts.signal?.throwIfAborted();
        if (opts.workRuntime && name === "edit_video") {
            const file = String(input.file || "").replace(/\\/g, "/").split("/").pop() || "";
            const count = (videoAttempts.get(file) || 0) + 1;
            videoAttempts.set(file, count);
            if (count > 2)
                return { error: "VIDEO RECOVERY BUDGET REACHED", diagnostic: { code: "recovery_exhausted", message: "Two edit calls for this source already ran; automatic recovery is inside the tool.", detail: "Use inspect_video and the retained error. Do not vary arguments to retry the same failing source or claim an unverified codec limitation." } };
        }
        const read = (0, reliability_js_1.isObservation)(name, input) || (0, reliability_js_1.isDiscovery)(name, input);
        const scrolling = opts.workRuntime && name === "computer" && input.action === "call" && ["browser_scroll", "browser_mouse_wheel"].includes(String(input.tool));
        const scrollCheckpoint = scrolling ? verification.continuationCheckpoint() : null;
        if (scrolling && !scrollCheckpoint)
            return { error: "Inspect the current page or scroll region before scrolling again. Read fresh rows after each scroll." };
        const sig = signature(name, input) + (scrolling ? ":" + scrollCheckpoint.progressKey : "") + (opts.workRuntime && read ? `:${observationRevision}` : "");
        const seen = (callCounts.get(sig) || 0) + 1;
        callCounts.set(sig, seen);
        const polling = opts.workRuntime && name === "computer" && input.action === "call" && input.tool === "browser_wait_for";
        const limit = polling ? 6 : opts.workRuntime && !read ? 1 : MAX_IDENTICAL_CALLS;
        const knownNotExecuted = opts.workRuntime && name === "computer" && seen === 2 && safeBrowserRetry.has(sig);
        if (seen > limit && !knownNotExecuted) {
            console.warn(`[agentLoop] refused repeat call ${seen}× ${name}`);
            return {
                error: "REPEATED CALL REFUSED",
                detail: `You have already called ${name} with these exact arguments ${seen - 1} times this turn. Do not repeat a possible action: it may already have taken effect. Inspect current state, use the evidence already returned, change approach, or report the specific blocker.`,
            };
        }
        if (opts.workRuntime) {
            if (!opts.workRuntime.tools.some(t => t.name === name))
                return { error: "Tool is not available in this mode" };
            if (name === "computer" && /^browser_mouse_(click|drag)_xy$/.test(String(input.tool)) && (0, index_js_1.getModelInfo)(lastModelUsed)?.supportsVision === false)
                return { error: "This selected model cannot see screenshots. Use observed semantic browser targets, or choose a vision-capable model for visual controls. No coordinate action was executed." };
            opts.onEvent?.({ type: "tool", name, status: "running" });
            try {
                const result = await opts.workRuntime.execute(name, input);
                safeBrowserRetry.delete(sig);
                if (name === "computer" && result?.recovery?.actionOutcome === "not_executed" && result?.recovery?.safeToRetry === true)
                    safeBrowserRetry.add(sig);
                opts.onEvent?.({ type: "tool", name, status: result?.error ? "error" : "done" });
                return result;
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                opts.onEvent?.({ type: "tool", name, status: "error", detail });
                return { error: detail };
            }
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
    const runTool = async (name, input) => {
        if (opts.workRuntime && name === "continue_work") {
            try {
                if (!opts.allowContinuation || !opts.workRuntime.tools.some(t => t.name === "continue_work"))
                    throw new Error("Continuation is only available inside a saved interactive job");
                if (opts.workRuntime.pendingWork && !opts.workRuntime.pendingWork())
                    throw new Error("Save an unfinished task_plan for this authorized execution request before continuing; do not continue a status question or blocked task");
                verification.continuationEvidence(input.evidenceId, input.quote);
                if (!(0, reliability_js_1.canResumeFromReceipts)(verification.result().receipts, true))
                    throw new Error("Inspect the affected service after every uncertain action before continuing; an unrelated observation is not a read-back.");
                const delaySeconds = Number(input.delaySeconds);
                if (!Number.isInteger(delaySeconds) || delaySeconds < 10 || delaySeconds > 120)
                    throw new Error("Continuation delay must be 10–120 seconds");
                if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500)
                    throw new Error("Provide a short remaining-work checkpoint, without secrets");
                continuation = { delaySeconds, reason: input.reason, progressKey: verification.continuationCheckpoint()?.progressKey };
                return { waiting: true, note: "The saved job will resume. No external action will be replayed automatically." };
            }
            catch (e) {
                return { error: e.message };
            }
        }
        if (opts.workRuntime && name === "verify_source_values") {
            try {
                return verification.verifyValues(input);
            }
            catch (e) {
                return { error: e.message };
            }
        }
        if (opts.workRuntime && name === "report_verification") {
            if (opts.allowContinuation && input.status === "blocked" && (0, execution_js_1.segmentLimit)(JSON.stringify(input.limitations || [])))
                return { error: "The turn limit does not block this saved job. Inspect current state, retain unfinished task_plan steps and continue_work automatically." };
            try {
                return verification.review(input);
            }
            catch (e) {
                return { error: e.message };
            }
        }
        if (opts.workRuntime && name === "work_records" && input.action === "save") {
            try {
                input = { ...input, _verifiedRecords: verification.projectRecords(input.records) };
            }
            catch (e) {
                return { error: e.message };
            }
        }
        let result = await executeTool(name, input);
        if (!opts.workRuntime)
            return result;
        if (result && typeof result === "object" && result._image && !opts.modelOverride) {
            effectiveJob = "vision";
            recoveryModel = undefined;
        }
        if (result && typeof result === "object" && result._image && (0, index_js_1.getModelInfo)(lastModelUsed)?.supportsVision === false && opts.modelOverride) {
            const { _image, ...rest } = result;
            result = { ...rest, imageUnavailableToModel: true, imageWarning: "Screenshot captured, but this model does not support image input. Do not claim to see it. Use semantic snapshots/targets, or choose a vision-capable model." };
        }
        const receipt = verification.record(name, input, result);
        if (!receipt.observation)
            observationRevision++;
        opts.onEvidence?.(receipt);
        if (result && typeof result === "object" && !Array.isArray(result)) {
            return { _harveyEvidence: receipt, ...Object.fromEntries(Object.entries(result).filter(([k]) => k !== "_harveyEvidence")) };
        }
        return { _harveyEvidence: receipt, data: result ?? null };
    };
    let providerRetries = 0;
    for (let step = 0; step < stepBudget; step++) {
        opts.signal?.throwIfAborted();
        if (!uninterrupted && opts.allowContinuation && opts.checkpointAt && Date.now() >= opts.checkpointAt && step < stepBudget - 3)
            step = stepBudget - 3;
        /* The final round runs with tools WITHHELD. The budget then ends in an
           answer assembled from everything gathered, instead of the dead-end
           "hit the tool loop limit" that discarded the whole turn's work. */
        const lastRound = step === stepBudget - 1;
        const summaryRound = opts.workRuntime ? step >= stepBudget - 3 : lastRound;
        const checkpointRound = !!opts.allowContinuation && !plainStatusRewrite && step === stepBudget - 3;
        const checkpointReadNeeded = checkpointRound && !verification.continuationCheckpoint();
        const stepTools = plainStatusRewrite ? undefined : checkpointRound ? activeTools?.filter(t => ["continue_work", "report_verification", ...(checkpointReadNeeded ? ["computer"] : [])].includes(t.name)) : summaryRound ? undefined : activeTools;
        const stepSystem = checkpointRound
            ? system + "\n\nCHECKPOINT ROUND: If authorized plan steps remain without a blocker, use continue_work with an exact current observation and a brief remaining-work note. If the last browser action lacks a read-back, use computer browser_snapshot now; only browser observations are allowed, never clicks, typing, navigation or other mutations. A continuation preserves this same job and budget; it must inspect current state before further actions. Otherwise report the actual verified result or concrete blocker. No external mutations are available in this round."
            : summaryRound && toolRounds > 0
                ? system +
                    "\n\nFINAL ROUND: no more actions are available this turn. Report verified progress and the precise unresolved reason using current evidence. If the execution budget is why work stopped, say it paused at its execution limit. Never substitute an unsupported website, alpha, permission or credit diagnosis for an execution or targeting limit. Distinguish an observed application error from a hypothesis. Do not claim the workflow finished without verification."
                : system;
        let out;
        try {
            out = await (0, index_js_1.complete)({
                job: effectiveJob,
                modelOverride: opts.modelOverride || recoveryModel,
                system: stepSystem,
                messages,
                tools: stepTools,
                maxTokens,
                sessionId: opts.sessionId,
                onToken: opts.workRuntime ? undefined : opts.onToken,
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
            if (err instanceof index_js_1.BudgetRefusedError) {
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
            const detail = err instanceof index_js_1.ModelLayerError ? err.summary : err instanceof Error ? err.message : String(err);
            if (opts.workRuntime && !opts.signal?.aborted && providerRetries < 3 && /timeout|timed out|\b(?:429|50[0234]|529)\b|temporarily unavailable|overloaded|ECONNRESET|fetch failed/i.test(detail)) {
                providerRetries++;
                step--;
                await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** (providerRetries - 1), 4000)));
                continue;
            }
            console.error("[agentLoop] model call failed:", detail);
            return {
                speech: /\b402\b|credits|afford/i.test(detail) ? "I couldn’t continue because the AI provider’s available credit limit won’t cover this request. Your files and completed work are still saved." : "I couldn’t get a response from the AI service. Your files and completed work are still saved; I haven’t restarted the task.",
                toolRounds,
                model,
                modelUsed: lastModelUsed,
                costUsd,
                promptTokens,
                completionTokens,
                cachedTokens,
                contextPlan: lastPlan,
                approvals: heldApprovals,
                modelError: detail,
            };
        }
        providerRetries = 0;
        costUsd += out.usage.costUsd;
        promptTokens += out.usage.promptTokens;
        completionTokens += out.usage.completionTokens;
        cachedTokens += out.usage.cachedTokens || 0;
        lastPlan = out.contextPlan;
        lastModelUsed = out.modelUsed;
        if (out.substituted)
            substituted = out.substituted;
        opts.onEvent?.({
            type: "usage",
            model: out.modelUsed,
            promptTokens: out.usage.promptTokens,
            completionTokens: out.usage.completionTokens,
            cachedTokens: out.usage.cachedTokens || 0,
            costUsd: out.usage.costUsd,
        });
        // Withheld tools are an execution boundary, including the presentation-only
        // rewrite. A provider returning an unsolicited call cannot reopen execution.
        if (!stepTools && out.toolUses.length) {
            out = { ...out, text: "", toolUses: [] };
        }
        if (opts.workRuntime && !out.toolUses.length && (!out.text.trim() || /<\|tool_call_start\|>|<function=[^>]+>|<tool_call>/.test(out.text))) {
            // Treat pseudo-tool markup as a provider formatting error, never execute it.
            // Retrying the model response keeps completed tool calls in context.
            if (!opts.modelOverride && !formatFallbackUsed && malformedRepairs >= 1 && !lastRound) {
                const alternate = (0, index_js_1.resolveModel)(effectiveJob, { exclude: [lastModelUsed] }).model;
                if (alternate !== lastModelUsed) {
                    recoveryModel = alternate;
                    formatFallbackUsed = true;
                    malformedRepairs = 0;
                    continue;
                }
            }
            if (!lastRound && malformedRepairs < 2) {
                malformedRepairs++;
                system += "\nRuntime format repair: your previous reply was empty or contained textual tool-call markup. No action from that text ran. Use the actual structured tool-call interface with the discovered schema, or return a plain-language outcome. Keep previously completed actions; do not repeat them.";
                continue;
            }
            if (opts.allowContinuation && opts.workRuntime?.pendingWork?.() && verification.result().status !== "blocked" && (0, reliability_js_1.canResumeFromReceipts)(verification.result().receipts, true)) {
                return { speech: "Recovering the AI response and continuing from saved progress.", continuation: { delaySeconds: 10, recovery: "model_response", reason: "The last model reply was malformed; no action from that reply ran. Inspect the saved task_plan, work_records and current site before continuing unfinished work. Do not repeat completed actions." }, verification: verification.result(), toolRounds, model, modelUsed: lastModelUsed, costUsd, promptTokens, completionTokens, cachedTokens, contextPlan: lastPlan };
            }
            return { speech: "The AI service repeatedly returned an empty or unusable response. The task is unfinished. Saved work is retained; any action without a confirmed result must be inspected before retrying.", modelError: "Empty or malformed model response after bounded repair; finish reason: " + String(out.stopReason || "unknown"), verification: verification.result(), toolRounds, model, modelUsed: lastModelUsed, costUsd, promptTokens, completionTokens, cachedTokens, contextPlan: lastPlan };
        }
        if (!out.toolUses.length) {
            if (uninterrupted && (0, execution_js_1.segmentLimit)(out.text) && falseLimitReminders < 2) {
                falseLimitReminders++;
                system += "\nRUNTIME CORRECTION: This saved task has NO tool-round or elapsed-task-time cutoff. All execution tools remain available. The previous draft's execution-limit claim is false. Continue the authorized work now; do not ask for another continue, reduce the requested scope, or substitute a different workflow. Keep the existing browser and saved records. Only actual completion, cancellation, an observed blocker, persistent no-progress, or provider/budget failure ends the task.";
                continue;
            }
            const browserReceipts = verification.result().receipts.filter(r => r.tool === "computer");
            if (opts.allowContinuation && opts.workRuntime && !summaryRound && !scrollRecoveryPrompted && browserReceipts.length && /(?:manual(?:ly)? scroll|you (?:must|need to|can|should) scroll|(?:automation|I) (?:can.t|cannot|can not) scroll|copy.paste approach|physically scrolling)/i.test(out.text) && !/captcha|disconnected|expired|permission denied|sign in yourself/i.test(out.text)) {
                scrollRecoveryPrompted = true;
                system += "\nBROWSER RETRIEVAL RECOVERY: Do not hand ordinary scrolling or copying back to the user based on missing rows. Discover this computer's tools and try browser_scroll with an observed scroll container (hosted: browser_inspect_scroll_regions; local: fresh snapshot refs), then read fresh rows. These semantic tools do not require a vision model. A saved snapshot offset is not scrolling. Check actual pagination/native export if appropriate. Preserve the user's filters and saved records. If an attempted operation genuinely fails, report that exact observed reason; do not infer missing data or unsupported automation. This correction does not authorize external writes or expand task scope.";
                continue;
            }
            if (opts.allowContinuation && opts.workRuntime?.pendingWork?.() && verification.result().status !== "blocked" && (summaryRound || unfinishedReminders >= 2 || /(?:say|reply|tell me|ask me).{0,45}continue|(?:turn|execution) (?:budget|limit)/i.test(out.text))) {
                const checkpoint = verification.continuationCheckpoint();
                if (checkpoint && (0, reliability_js_1.canResumeFromReceipts)(verification.result().receipts, true))
                    return { speech: "Continuing the remaining work automatically.", continuation: { delaySeconds: 10, reason: "Inspect the current state and saved work_records, then finish the remaining task_plan steps. Do not repeat completed actions.", progressKey: checkpoint.progressKey }, verification: verification.result(), toolRounds, model, modelUsed: lastModelUsed, costUsd, promptTokens, completionTokens, cachedTokens };
                if (!uninterrupted && !checkpoint && !summaryRound && unfinishedReminders >= 2) {
                    step = stepBudget - 4;
                    continue;
                }
            }
            if (opts.allowContinuation && !summaryRound && unfinishedReminders < 2 && opts.workRuntime?.pendingWork?.() && verification.result().status !== "blocked") {
                unfinishedReminders++;
                system += "\nThe authorized task still has unfinished plan steps and no concrete blocker. Verifying one profile or one step does not complete the whole request. Continue the next step without asking for confirmation. If the whole requested outcome is verified, checkpoint every completed task_plan step before finishing. Otherwise obtain a fresh observation and use continue_work. If genuinely blocked, checkpoint the precise observed reason before answering. An execution segment ending is not a user blocker.";
                continue;
            }
            if (opts.workRuntime?.loginEmailAvailable && !emailRecoveryPrompted && !summaryRound && /(?:share|provide|send me|check your|need you|need the).{0,100}(?:code|inbox)|(?:code).{0,60}(?:from you|share it)/is.test(out.text)) {
                emailRecoveryPrompted = true;
                system += "\nAn authorized connected mailbox is available. Before asking the user to supply this sign-in code, discover and search the matching recent login email yourself, if the login is authorized. Match site, recipient and current request; do not use unrelated codes or print/save them. If access actually fails, explain that observed reason. Do not bypass CAPTCHA/device approval. Keep the existing login page; do not restart login.";
                continue;
            }
            // A missing review is our bookkeeping problem, never a request for the
            // user to re-authorize a login. Give the agent a bounded chance to act or
            // inspect its results before returning; ordinary conversation needs none.
            const evidence = verification.result();
            // Negative instructions are constraints, not evidence that an action was requested.
            const affirmativeMessage = opts.message.replace(/\b(?:do not|don['’]t|never|without)\b[^.!?\n]*(?:[.!?]|$)/gi, "");
            const actionRequested = /\b(log\s*in|sign\s*in|connect\s+to|open\s+https?:|go\s+to|navigate|create|schedule|send|update|delete|check\s+the|read\s+the)\b/i.test(affirmativeMessage) || /https?:\/\/\S+/i.test(affirmativeMessage);
            if (opts.workRuntime && !plainStatusRewrite && !lastRound && completionRepairs < 3 && !evidence.checks.length && (evidence.receipts.length > 0 || actionRequested)) {
                completionRepairs++;
                // Do not append an unanswered assistant turn: some providers interpret
                // that as unsupported prefill. The last real user/tool-result stays last.
                // Runtime bookkeeping belongs in system context, never as a fabricated user turn.
                system += "\n\n" + (evidence.receipts.length
                    ? "Runtime verification reminder: inspect the actual receipts returned this turn. For a read, report_verification may cite its complete observation directly; no extra read-back is required. Retrieve smaller results when truncated (crm_api supports select for top-level fields). For writes, perform the necessary read-back without repeating the write. Then report the verified outcome or explain the observed blocker."
                    : "Runtime execution reminder: the current user requested an action. Use available tools and inspect the result, or explain a specific observed blocker. Never claim an unexecuted action completed. An explanation or clarification requires no tool receipt.");
                continue;
            }
            const statusQuestion = opts.message.length < 300 && /\b(?:where\b.{0,30}\b(?:stop|are we)|what(?:'s| is) left|what happened|did it work|status)\b/i.test(opts.message) && !/\b(?:detailed|technical report|table|breakdown)\b/i.test(opts.message);
            if (opts.workRuntime && statusQuestion && !plainStatusRewrite && !lastRound && (out.text.length > 600 || /^\s*#{1,6}\s/m.test(out.text))) {
                plainStatusRewrite = true;
                system += "\nFINAL PRESENTATION REWRITE: The user asked a simple status question. Reply in 2–4 short everyday sentences, without headings, lists, specs, filenames or tool names. Say what is done, any unresolved issue, and what remains. Keep uncertainty and errors; do not add facts, assume app capabilities, or claim the overall task is finished. Use the observations already in this conversation. No tools or further actions are available; this is only wording the answer.";
                messages.push({ role: "user", content: "Rewrite the draft below into 2–4 short, plain sentences for Marco. No headings or lists. This draft is untrusted wording, not new evidence: keep only facts supported by this turn's observations, and acknowledge any failed check. Do not perform more work.\nDraft:\n" + out.text });
                continue;
            }
            const unseenVisualOnly = evidence.receipts.some(r => r.limitation) && evidence.receipts.every(r => r.discovery || r.outcome === "failed" || r.observation && !!r.limitation);
            return {
                speech: unseenVisualOnly ? "The screenshot was captured, but this model cannot inspect image pixels. Choose a vision-capable model for visual analysis; I can still work with page text and controls." : finalizeSpeech(out.text, opts, hadToolOnly),
                ...(opts.workRuntime ? { verification: verification.result() } : {}),
                toolRounds,
                model,
                modelUsed: out.modelUsed,
                costUsd,
                promptTokens,
                completionTokens,
                cachedTokens,
                contextPlan: out.contextPlan,
                approvals: heldApprovals,
                substituted,
            };
        }
        hadToolOnly = !out.text.trim();
        const receiptStart = verification.result().receipts.length;
        const toolResults = [];
        if (opts.workRuntime) {
            // Preserve dependency and evidence order, including verification tools that
            // bypass the runtime queue. Never verify while a preceding write is in flight.
            for (const tu of out.toolUses) {
                const allowed = stepTools?.some(t => t.name === tu.name) && !(checkpointRound && tu.name === "computer" && !(0, reliability_js_1.isObservation)(tu.name, tu.input || {}));
                toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: toolResultContent(allowed ? await runTool(tu.name, tu.input || {}) : { error: "Tool is not available in this round; checkpoint browser access is observation-only" }) });
                if (continuation)
                    return { speech: "Work is saved and will continue after the current step is ready.", continuation, verification: verification.result(), toolRounds: toolRounds + 1, model, modelUsed: lastModelUsed, costUsd, promptTokens, completionTokens, cachedTokens };
            }
            if (uninterrupted) {
                const progressed = verification.result().receipts.slice(receiptStart).some(r => r.outcome === "returned");
                idleToolRounds = progressed ? 0 : idleToolRounds + 1;
                if (progressed)
                    falseLimitReminders = 0;
                if (idleToolRounds >= 8)
                    return { speech: "The last eight tool rounds produced no successful operation. The task is unfinished; I could not recover from the repeated tool failures. Saved work is retained.", verification: verification.result(), modelError: "Repeated tool failures without progress", toolRounds, model, modelUsed: lastModelUsed, costUsd, promptTokens, completionTokens, cachedTokens };
            }
        }
        else {
            toolResults.push(...await Promise.all(out.toolUses.map(async (tu) => ({ type: "tool_result", tool_use_id: tu.id, content: toolResultContent(await runTool(tu.name, tu.input || {})) }))));
        }
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
        cachedTokens,
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
