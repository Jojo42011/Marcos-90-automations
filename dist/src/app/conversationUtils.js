"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REFERRAL_AREA_FOLLOW_UP = exports.MAX_CALL_ASK_ATTEMPTS = exports.MARCO_CALL_ASK_ATTEMPT_LINES = exports.DENIAL_OF_INQUIRY_REPLY = exports.REALTOR_RELOCATION_REPLY = exports.REALTOR_REDIRECT_REPLY = void 0;
exports.detectAdCampaign = detectAdCampaign;
exports.normalizeUserMessageText = normalizeUserMessageText;
exports.isExactDuplicateMessage = isExactDuplicateMessage;
exports.getDuplicateMessageResponse = getDuplicateMessageResponse;
exports.isDuplicateHandle = isDuplicateHandle;
exports.getPhoneRequestCount = getPhoneRequestCount;
exports.getPhoneRequestVariation = getPhoneRequestVariation;
exports.isSimpleAcknowledgment = isSimpleAcknowledgment;
exports.agentMessageCommittedToSend = agentMessageCommittedToSend;
exports.detectCommunicationStyle = detectCommunicationStyle;
exports.getCommunicationStyleInstructions = getCommunicationStyleInstructions;
exports.isRealtorMessage = isRealtorMessage;
exports.isRealtorAndRelocating = isRealtorAndRelocating;
exports.isDenialOfInquiry = isDenialOfInquiry;
exports.enforceOutboundTextRules = enforceOutboundTextRules;
exports.normalizeForMarcoDuplicateCompare = normalizeForMarcoDuplicateCompare;
exports.messagesAreSubstantiallyDuplicate = messagesAreSubstantiallyDuplicate;
exports.getRecentAssistantTexts = getRecentAssistantTexts;
exports.getLastUserMessageText = getLastUserMessageText;
exports.isWaveOnlyMessage = isWaveOnlyMessage;
exports.getLastAssistantMessageText = getLastAssistantMessageText;
exports.lastAssistantMessageMatches = lastAssistantMessageMatches;
exports.countAssistantMessagesMatchingAny = countAssistantMessagesMatchingAny;
exports.countCallAskAttempts = countCallAskAttempts;
exports.threadContainsGracefulCallAskExit = threadContainsGracefulCallAskExit;
exports.threadHadCallAskPath = threadHadCallAskPath;
exports.lastAssistantWasCallAsk = lastAssistantWasCallAsk;
exports.resolvePhoneCapturedReply = resolvePhoneCapturedReply;
exports.threadContainsBreakdownOffer = threadContainsBreakdownOffer;
exports.signalsAffirmativeBreakdownAgreement = signalsAffirmativeBreakdownAgreement;
exports.signalsCallAskAgreement = signalsCallAskAgreement;
exports.isInStateConfirmation = isInStateConfirmation;
exports.isEmailDeflection = isEmailDeflection;
exports.asksAboutCommissionRebate = asksAboutCommissionRebate;
exports.resolveCallAskBucketF = resolveCallAskBucketF;
exports.isAcknowledgmentOnly = isAcknowledgmentOnly;
exports.resolveAcknowledgmentCloseoutTurn = resolveAcknowledgmentCloseoutTurn;
exports.lastTwoAssistantMessagesAreDuplicate = lastTwoAssistantMessagesAreDuplicate;
exports.latestAssistantEchoesEarlierInThread = latestAssistantEchoesEarlierInThread;
exports.threadContainsAgentQuestion = threadContainsAgentQuestion;
exports.threadContainsFirstTimeBuyingQuestion = threadContainsFirstTimeBuyingQuestion;
exports.isFirstTimeBuyingOpener = isFirstTimeBuyingOpener;
exports.leadThreadSignalsExperiencedBuyer = leadThreadSignalsExperiencedBuyer;
exports.messageAsksPropertyPriceOrCost = messageAsksPropertyPriceOrCost;
exports.signalsWantsInfoInDmOnly = signalsWantsInfoInDmOnly;
exports.signalsWantsBreakdownImmediately = signalsWantsBreakdownImmediately;
exports.signalsEmailDeliveryRequest = signalsEmailDeliveryRequest;
exports.messageAsksBuilderIdentity = messageAsksBuilderIdentity;
exports.leadTextSignalsNoAgent = leadTextSignalsNoAgent;
exports.isDuplicateMarcoReply = isDuplicateMarcoReply;
exports.candidateMatchesRecentMarco = candidateMatchesRecentMarco;
exports.isLastUserMessageRepeated = isLastUserMessageRepeated;
exports.messageAsksListingLocation = messageAsksListingLocation;
exports.messageAsksWhatCity = messageAsksWhatCity;
exports.signalsLookingOutsideSanAntonio = signalsLookingOutsideSanAntonio;
exports.detectOutOfStateLead = detectOutOfStateLead;
exports.threadContainsReferralOffer = threadContainsReferralOffer;
exports.signalsReferralAcceptance = signalsReferralAcceptance;
exports.signalsReferralDeclineOrWantsSanAntonio = signalsReferralDeclineOrWantsSanAntonio;
exports.buildOutOfStateReferralOffer = buildOutOfStateReferralOffer;
exports.countAssistantsSinceLastUser = countAssistantsSinceLastUser;
exports.countTrailingAssistantsAtEnd = countTrailingAssistantsAtEnd;
exports.isShortDuplicateUserPair = isShortDuplicateUserPair;
exports.signalsExplicitPhoneRefusal = signalsExplicitPhoneRefusal;
exports.threadContainsPhoneRefusalApology = threadContainsPhoneRefusalApology;
exports.isBusinessPitchInquiry = isBusinessPitchInquiry;
exports.signalsBuyingConfusion = signalsBuyingConfusion;
exports.resolveBuyingConfusionReply = resolveBuyingConfusionReply;
exports.claimsAlreadySentNumber = claimsAlreadySentNumber;
exports.countNumberNotReceivedReplies = countNumberNotReceivedReplies;
exports.resolveNumberNotReceivedReply = resolveNumberNotReceivedReply;
const prompts_js_1 = require("../../config/prompts.js");
/**
 * Map first inbound message phrases to internal ad campaign ids (Instagram ad attribution).
 */
function detectAdCampaign(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return null;
    if (t.includes("low intrest") ||
        t.includes("low interest") ||
        t.includes("how fast can i close") ||
        t.includes("time i can tour")) {
        return "low_interest_ad";
    }
    if (t.includes("rent from this property") || t.includes("available for a tour")) {
        return "canyon_lake_ad";
    }
    return null;
}
/** Normalize for comparing lead messages (repeat taps, etc.). */
function normalizeUserMessageText(text) {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
}
/** Message handle dedup store — prevents the same webhook payload from processing twice. */
const recentlyProcessedHandles = new Map();
/**
 * Detects if the current user message is an exact duplicate of the prior user message
 * in the conversation history (excludes the current turn when history already includes it).
 */
function isExactDuplicateMessage(currentMessage, conversationHistory) {
    if (!currentMessage?.trim() || !conversationHistory?.length) {
        return false;
    }
    const normalizedCurrent = currentMessage.trim().toLowerCase();
    const userMessages = conversationHistory
        .filter((turn) => turn.role === "user")
        .map((turn) => (turn.content ?? "").trim().toLowerCase());
    if (userMessages.length < 2)
        return false;
    const mostRecentPriorUserMessage = userMessages[userMessages.length - 2];
    return normalizedCurrent === mostRecentPriorUserMessage;
}
/** Human-curious response when a lead sends the exact same message twice. */
function getDuplicateMessageResponse() {
    const responses = [
        "Did you mean to send that again?",
        "Looks like that came through twice. Did you want me to go into more detail?",
        "Hey, did you mean to resend that? Just want to make sure I got you.",
        "?",
        "Just checking. Did that send twice on your end? Happy to clarify anything.",
        "Looks like you sent that one more than once. Is there something specific you needed me to explain better?",
    ];
    const index = Math.floor(Date.now() / 10000) % responses.length;
    return responses[index];
}
function isDuplicateHandle(messageHandle) {
    if (!messageHandle?.trim())
        return false;
    const handle = messageHandle.trim();
    const processedAt = recentlyProcessedHandles.get(handle);
    if (processedAt) {
        const ageMs = Date.now() - processedAt;
        if (ageMs < 60000) {
            console.log(`[dedup] Message handle ${handle} already processed ${ageMs}ms ago — dropping`);
            return true;
        }
    }
    recentlyProcessedHandles.set(handle, Date.now());
    if (recentlyProcessedHandles.size > 500) {
        const cutoff = Date.now() - 120000;
        for (const [h, ts] of recentlyProcessedHandles.entries()) {
            if (ts < cutoff)
                recentlyProcessedHandles.delete(h);
        }
    }
    return false;
}
/**
 * Counts how many times the agent has already asked for a phone number in this conversation.
 */
function getPhoneRequestCount(conversationHistory) {
    if (!conversationHistory?.length)
        return 0;
    const phoneAskPatterns = [
        "good number",
        "phone number",
        "number would be best",
        "send that over to",
        "reach you at",
        "best number",
        "can i get a number",
        "grab your number",
    ];
    return conversationHistory
        .filter((turn) => turn.role === "assistant")
        .filter((turn) => {
        const content = (turn.content ?? "").toLowerCase();
        return phoneAskPatterns.some((pattern) => content.includes(pattern));
    }).length;
}
/** Phone request variation hint for the LLM based on prior ask count. */
function getPhoneRequestVariation(askCount) {
    if (askCount === 0) {
        return "FIRST ASK. Standard approach. Ask for number naturally as part of getting them info.";
    }
    if (askCount === 1) {
        return "SECOND ASK. Lead already declined once. Be slightly more casual and human. Add a touch of self-aware humor if they showed any frustration. Example approach: \"LOL I'm sorry, I promise I'm not trying to be difficult. For this specific property a number is honestly just the fastest way to get you everything.\"";
    }
    if (askCount === 2) {
        return "THIRD ASK. Lead has declined twice. Take a completely different angle. Acknowledge their hesitation genuinely. Example: \"I completely understand, no pressure at all. I just want to make sure you get all the details as fast as possible, and a number is truly the quickest way I can do that for you.\"";
    }
    return "FOURTH ASK OR MORE. Back off entirely. Do not ask for number again this turn. Find another way to keep the conversation going and build trust. The number will come when they are ready.";
}
/**
 * Detects if the current message is a simple acknowledgment that
 * does not require or merit a substantive response.
 */
function isSimpleAcknowledgment(message) {
    const normalized = message.trim().toLowerCase();
    const acknowledgments = [
        "okay",
        "ok",
        "k",
        "kk",
        "sounds good",
        "got it",
        "perfect",
        "alright",
        "alright!",
        "cool",
        "cool!",
        "nice",
        "great",
        "thanks",
        "thank you",
        "ty",
        "thx",
        "👍",
        "👍🏽",
        "👍🏼",
        "👍🏾",
        "👍🏿",
        "👏",
        "🙏",
        "✓",
        "✔",
        "✔️",
        "yep",
        "yup",
        "yeah",
        "sure",
        "good",
        "👌",
        "ight",
        "aight",
        "bet",
        "🤙",
        "bye",
        "bye bye",
        "byebye",
        "goodbye",
        "cya",
        "ttyl",
        "you too",
        "u too",
        "gotta go",
    ];
    if (normalized.length <= 15 &&
        acknowledgments.some((a) => normalized === a || normalized === a + "!")) {
        return true;
    }
    const emojiOnly = /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s!.]+$/u;
    if (emojiOnly.test(message.trim())) {
        return true;
    }
    return false;
}
/** True when Marco's last outbound committed to sending info to the lead. */
function agentMessageCommittedToSend(lastAgentMessage) {
    if (!lastAgentMessage?.trim())
        return false;
    const t = lastAgentMessage.toLowerCase();
    return (t.includes("get that over to you") ||
        t.includes("send that over") ||
        t.includes("end of day") ||
        t.includes("by tonight") ||
        t.includes("will send") ||
        t.includes("i'll get that") ||
        t.includes("ill get that"));
}
/**
 * Analyzes the lead's conversation messages to detect their communication style.
 */
function detectCommunicationStyle(conversationHistory) {
    const leadMessages = conversationHistory.filter((t) => t.role === "user").map((t) => t.content);
    if (!leadMessages.length)
        return "casual";
    const combined = leadMessages.join(" ");
    const totalChars = combined.length;
    const exclamationCount = (combined.match(/!/g) || []).length;
    const periodCount = (combined.match(/\./g) || []).length;
    const capitalCount = (combined.match(/[A-Z]/g) || []).length;
    const emojiCount = (combined.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
    const avgMessageLength = totalChars / leadMessages.length;
    const hasCapitalization = capitalCount > leadMessages.length;
    const hasEndPunctuation = periodCount >= leadMessages.length * 0.5;
    const isExcited = exclamationCount >= 2;
    const isTerse = avgMessageLength < 12;
    if (isExcited || emojiCount >= 3)
        return "excited";
    if (isTerse && !hasCapitalization && !hasEndPunctuation)
        return "terse";
    if (hasCapitalization && hasEndPunctuation)
        return "formal";
    return "casual";
}
/** Style instructions for the LLM based on detected communication style. */
function getCommunicationStyleInstructions(style) {
    switch (style) {
        case "formal":
            return "COMMUNICATION STYLE: This lead writes formally with capitalization and punctuation. Match their level. Complete sentences are fine. Professional but still warm.";
        case "excited":
            return "COMMUNICATION STYLE: This lead uses exclamation points and/or emojis. They are upbeat and energetic. Match their energy. Short enthusiastic responses work well. One emoji is okay if it fits naturally.";
        case "terse":
            return "COMMUNICATION STYLE: This lead writes very short messages with no punctuation and likely no capitals. Match this style. Keep responses SHORT. Do not use formal phrases. Say \"gotcha\" not \"I understand.\" Say \"for sure\" not \"of course.\" Never use \"great question\" or formal opener words. One or two sentences max. Match their brevity.";
        case "casual":
        default:
            return "COMMUNICATION STYLE: This lead writes casually without heavy punctuation. Keep a natural, relaxed tone. No \"Of course\" openers. No \"Great question.\" Just talk like a real person would. Contractions always.";
    }
}
/** Detects if the lead is identifying as a realtor, agent, or broker. */
function isRealtorMessage(message) {
    const normalized = message.toLowerCase();
    const realtorSignals = [
        "i'm a realtor",
        "i am a realtor",
        "im a realtor",
        "i'm a real estate agent",
        "i am an agent",
        "im an agent",
        "i'm an agent",
        "i'm a broker",
        "im a broker",
        "fellow agent",
        "fellow realtor",
        "i'm also in real estate",
        "i sell homes",
        "i'm in the business",
        "i work in real estate",
        "i'm a licensed",
        "i represent",
        "my client is interested",
        "representing a buyer",
        "buyers agent",
        "buyer's agent",
        "listing agent",
    ];
    return realtorSignals.some((signal) => normalized.includes(signal));
}
exports.REALTOR_REDIRECT_REPLY = "Hey! Sounds like you're in the business too, love it. For agent inquiries, feel free to reach out to Marco directly at 210-801-2380 and he'll get back to you as soon as possible.";
/** Realtor who mentions relocating to Texas — ask where they're coming from (referral opportunity). */
exports.REALTOR_RELOCATION_REPLY = "Oh awesome, where are you relocating from? If you're not licensed in Texas, I may be able to help facilitate the transaction on the listing side.";
/** True if the realtor message also mentions relocating to the area (potential referral situation). */
function isRealtorAndRelocating(text) {
    if (!isRealtorMessage(text))
        return false;
    const t = text.trim().toLowerCase();
    return /\b(relocat(ing|e|ion)|moving (here|to|into)|transferr?ing)\b/.test(t);
}
/** Lead explicitly says they did not inquire or reach out. */
function isDenialOfInquiry(message) {
    const normalized = message.toLowerCase();
    const denialPatterns = [
        "i didn't inquire",
        "i did not inquire",
        "i didn't reach out",
        "i didn't message",
        "i didn't contact",
        "i didn't send",
        "i didn't ask",
        "wrong person",
        "i think you have the wrong",
        "not me",
        "wasn't me",
        "i didn't do anything",
        "i never messaged",
    ];
    return denialPatterns.some((pattern) => normalized.includes(pattern));
}
exports.DENIAL_OF_INQUIRY_REPLY = "My apologies for the confusion! You may have been included in an automated follow-up by mistake. Hope you have a great day, and feel free to reach out anytime if you ever have questions about real estate in San Antonio!";
/** Strip punctuation variance and unicode noise for Marco duplicate checks. */
/**
 * Deterministic backstop for two house-style rules the prompt bans but the
 * model still violates in production (confirmed live: em dash in "Yeah, of
 * course — is there a good number", and "Great question" opener despite an
 * explicit ban in config/prompts.ts and founderPrompt.ts). Prompt-only
 * enforcement is not reliable enough on its own — this runs on every
 * LLM-generated reply right before it is sent, so a violation can never
 * reach a lead regardless of what the model draft contains.
 *
 * - Em dash / en dash → comma (matches "use only periods, commas, question
 *   marks, exclamation marks, apostrophes").
 * - Leading "Great question" opener → stripped; the rest of the sentence is
 *   capitalized so it still reads naturally.
 */
function enforceOutboundTextRules(text) {
    if (!text)
        return text;
    let out = text.replace(/[—–]\s*/g, ", ").replace(/\s*,\s*,/g, ",");
    out = out.replace(/^\s*great question[.,!]?\s*/i, "");
    out = out.replace(/^([a-z])/, (m) => m.toUpperCase());
    out = out.replace(/\s+,/g, ",").replace(/,\s*$/, "").trim();
    return out;
}
function normalizeForMarcoDuplicateCompare(text) {
    let s = text
        .trim()
        .toLowerCase()
        .normalize("NFKC")
        .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
        .replace(/\s+/g, " ");
    s = s.replace(/[^\p{L}\p{N}\s]/gu, " ");
    return s.replace(/\s+/g, " ").trim();
}
function diceBigramSimilarity(a, b) {
    const t = (x) => normalizeForMarcoDuplicateCompare(x).replace(/\s/g, "");
    const A = t(a);
    const B = t(b);
    if (A.length < 2 || B.length < 2)
        return 0;
    const bigramCounts = (s) => {
        const m = new Map();
        for (let i = 0; i < s.length - 1; i++) {
            const g = s.slice(i, i + 2);
            m.set(g, (m.get(g) ?? 0) + 1);
        }
        return m;
    };
    const mA = bigramCounts(A);
    const mB = bigramCounts(B);
    let inter = 0;
    for (const [g, c] of mA)
        inter += Math.min(c, mB.get(g) ?? 0);
    return (2 * inter) / (A.length - 1 + (B.length - 1));
}
function wordJaccard(a, b) {
    const words = (s) => {
        const set = new Set();
        for (const w of normalizeForMarcoDuplicateCompare(s).split(/\s+/)) {
            if (w.length > 2)
                set.add(w);
        }
        return set;
    };
    const A = words(a);
    const B = words(b);
    if (A.size === 0 || B.size === 0)
        return 0;
    let inter = 0;
    for (const w of A)
        if (B.has(w))
            inter++;
    return inter / (A.size + B.size - inter);
}
/**
 * True if two Marco-sized replies are the same idea (fuzzy), not only exact match.
 */
function messagesAreSubstantiallyDuplicate(a, b) {
    if (!a?.trim() || !b?.trim())
        return false;
    const c = normalizeForMarcoDuplicateCompare(a);
    const l = normalizeForMarcoDuplicateCompare(b);
    if (!c || !l)
        return false;
    if (c === l)
        return true;
    const minLen = Math.min(c.length, l.length);
    const maxLen = Math.max(c.length, l.length);
    if (minLen >= 24) {
        const prefix = Math.min(72, minLen);
        if (c.slice(0, prefix) === l.slice(0, prefix))
            return true;
    }
    if (minLen >= 30 && maxLen > 0 && minLen / maxLen >= 0.92) {
        if (c.includes(l.slice(0, Math.min(40, l.length))) || l.includes(c.slice(0, Math.min(40, c.length)))) {
            return true;
        }
    }
    const wcA = c.split(/\s+/).filter((w) => w.length > 2).length;
    const wcB = l.split(/\s+/).filter((w) => w.length > 2).length;
    if (wcA >= 6 && wcB >= 6) {
        const j = wordJaccard(a, b);
        if (j >= 0.68)
            return true;
    }
    if (minLen >= 40) {
        const d = diceBigramSimilarity(a, b);
        if (d >= 0.78)
            return true;
    }
    return false;
}
/** Last N assistant lines, newest first. */
function getRecentAssistantTexts(conversation, n) {
    const out = [];
    for (let i = conversation.messages.length - 1; i >= 0 && out.length < n; i--) {
        const m = conversation.messages[i];
        if (m.role === "assistant" && m.text?.trim())
            out.push(m.text.trim());
    }
    return out;
}
/** Last user line in the thread (most recent Lead message). */
function getLastUserMessageText(conversation) {
    const reversed = [...conversation.messages].reverse();
    const m = reversed.find((x) => x.role === "user");
    return m?.text?.trim() ?? "";
}
/** Wave / raised-hand emoji (👋 🤚 🖐 🏻-🏿 optional skin tones on some platforms). */
const WAVE_EMOJI_RE = /(?:\u{1F44B}|\u{1F91A}|\u{1F590}|\u{270B})(?:\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF})?/gu;
/**
 * Message is only a wave or bare hi/hello — emoji-only, "wave", or short greeting with no other content.
 * Bare "hey" alone is excluded (stays on buyer-intent gate).
 */
function isWaveOnlyMessage(text) {
    const raw = text.trim();
    if (!raw)
        return false;
    const withoutWaves = raw.replace(WAVE_EMOJI_RE, "").trim();
    if (withoutWaves === "" && WAVE_EMOJI_RE.test(raw))
        return true;
    const textOnly = withoutWaves.toLowerCase().replace(/[!.,…]+/g, "").trim();
    if (!textOnly)
        return false;
    return /^(wave|waving|hey wave|hi wave|hi|hello|hi there|hello there)$/.test(textOnly);
}
/** Last Marco outbound before the reply we are about to generate (most recent assistant message). */
function getLastAssistantMessageText(conversation) {
    const reversed = [...conversation.messages].reverse();
    const m = reversed.find((x) => x.role === "assistant");
    return m?.text?.trim() ? m.text.trim() : null;
}
/** True if Marco's most recent outbound substantially matches a target line (e.g. close-out). */
function lastAssistantMessageMatches(conversation, target) {
    const last = getLastAssistantMessageText(conversation);
    if (!last?.trim() || !target.trim())
        return false;
    return messagesAreSubstantiallyDuplicate(last, target);
}
/** Canonical Bucket F call-ask lines (shared retry counter across all three). */
exports.MARCO_CALL_ASK_ATTEMPT_LINES = [
    prompts_js_1.MARCO_CALL_ASK_INSTATE,
    prompts_js_1.MARCO_CALL_ASK_EMAIL_DEFLECT,
    prompts_js_1.MARCO_REBATE_REPLY,
];
/** Allow up to this many call-ask attempts before graceful exit on the next trigger. */
exports.MAX_CALL_ASK_ATTEMPTS = 2;
/** Count Marco outbounds that substantially match any target in the list. */
function countAssistantMessagesMatchingAny(conversation, targets) {
    let count = 0;
    for (const m of conversation.messages) {
        if (m.role !== "assistant" || !m.text?.trim())
            continue;
        for (const target of targets) {
            if (messagesAreSubstantiallyDuplicate(m.text, target)) {
                count++;
                break;
            }
        }
    }
    return count;
}
function countCallAskAttempts(conversation) {
    return countAssistantMessagesMatchingAny(conversation, exports.MARCO_CALL_ASK_ATTEMPT_LINES);
}
function threadContainsGracefulCallAskExit(conversation) {
    return conversation.messages.some((m) => m.role === "assistant" &&
        m.text?.trim() &&
        messagesAreSubstantiallyDuplicate(m.text, prompts_js_1.MARCO_CALL_ASK_GRACEFUL_EXIT));
}
function threadHadCallAskPath(conversation) {
    return countCallAskAttempts(conversation) > 0;
}
function lastAssistantWasCallAsk(conversation) {
    const last = getLastAssistantMessageText(conversation);
    if (!last?.trim())
        return false;
    return exports.MARCO_CALL_ASK_ATTEMPT_LINES.some((line) => messagesAreSubstantiallyDuplicate(last, line));
}
/** Phone-captured confirm: call-ask path uses call-specific wording (Option B). */
function resolvePhoneCapturedReply(conversation) {
    if (threadHadCallAskPath(conversation)) {
        return prompts_js_1.MARCO_PHONE_CAPTURED_CALL_REPLY;
    }
    return prompts_js_1.MARCO_PHONE_CAPTURED_REPLY;
}
/** Marco already offered the breakdown packet by text in this thread. */
function threadContainsBreakdownOffer(conversation) {
    for (const m of conversation.messages) {
        if (m.role !== "assistant" || !m.text?.trim())
            continue;
        if (messagesAreSubstantiallyDuplicate(m.text, prompts_js_1.MARCO_PRICE_REPLY))
            return true;
        const t = m.text.toLowerCase();
        if (/\bwould it help if i sent\b/.test(t) && /\bbreakdown\b/.test(t))
            return true;
        if (/\bsent over the entire breakdown\b/.test(t))
            return true;
        if (/\bfull breakdown\b/.test(t) && /\b(text|send|sent|by text)\b/.test(t))
            return true;
    }
    return false;
}
/**
 * Lead affirmatively agreed to receive the breakdown (pre-phone).
 * Narrow: short yes/send-it beats only — not location, rebate, or email deflection.
 */
function signalsAffirmativeBreakdownAgreement(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    const digits = t.replace(/\D/g, "");
    if (digits.length >= 10)
        return false;
    if (isInStateConfirmation(text))
        return false;
    if (isEmailDeflection(text))
        return false;
    if (asksAboutCommissionRebate(text))
        return false;
    if (/^(yes|yeah|yep|yup|sure|ok|okay|please|absolutely|definitely)\b/.test(t))
        return true;
    if (/^(yes|yeah|sure)[!.]*$/.test(t))
        return true;
    if (/\b(yes please|please send|send it|send that|send the|sounds good|that would be (great|helpful|awesome)|go ahead|go for it)\b/.test(t)) {
        return true;
    }
    if (/\b(i'?d like|i would like).{0,24}\b(send|sent|breakdown)\b/.test(t))
        return true;
    return false;
}
/** Lead agreed to Marco's call-ask (any of the three Bucket F lines). */
function signalsCallAskAgreement(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (/^(no|nah|nope|not really)\b/.test(t) && !/\b(yes|yeah|sure|open)\b/.test(t))
        return false;
    if (/\b(no thanks|not interested|don'?t want|dont want|can'?t|cant)\b/.test(t) && !/\b(open|yes|sure)\b/.test(t)) {
        return false;
    }
    return (/^(yes|yeah|yep|yup|sure|ok|okay|absolutely|definitely)\b/.test(t) ||
        /\b(i'?m open|open to (a |that|it)|that works|sounds good|works for me|five minutes|5 minutes|happy to|would be open)\b/.test(t) ||
        /\b(let'?s do|lets do|call me|give me a call)\b/.test(t));
}
/**
 * Clear, unambiguous in-state confirmation (Texas / San Antonio area).
 * Ambiguous location mentions → false (normal funnel).
 */
function isInStateConfirmation(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (/^(yes,?\s*)?(i'?m|im|i am|we'?re|were)\s+(in|based in|located in|living in)\s+(san antonio|\bsa\b|texas)\b/.test(t)) {
        return true;
    }
    if (/^(yes|yeah|yep|yup)[,!.]?\s*(i'?m|im|i am)\s+(in\s+)?(san antonio|\bsa\b|texas)\b/.test(t))
        return true;
    if (/^in\s+(texas|san antonio|\bsa\b)\s*[!.]*$/.test(t))
        return true;
    if (/^(san antonio|\bsa\b|texas)\s*[!.]*$/.test(t))
        return true;
    if (/^(yes|yeah)[,!.]?\s*(san antonio|\bsa\b|texas)\s*[!.]*$/.test(t))
        return true;
    // Location-first phrasing: "In Texas, yes" / "In San Antonio, yeah" — same
    // confirmation, just location leading with the yes/yeah trailing.
    if (/^in\s+(texas|san antonio|\bsa\b)\s*,?\s*(yes|yeah|yep|yup)[!.]*$/.test(t))
        return true;
    if (t.length < 72 &&
        /\b(i'?m|im|i am|we'?re|were)\s+(in|based in|located in|living in)\s+(san antonio|\bsa\b)\b/.test(t)) {
        return true;
    }
    if (t.length < 72 &&
        /\b(i'?m|im|i am|we'?re|were)\s+(in|based in|located in|living in)\s+texas\b/.test(t)) {
        return true;
    }
    return false;
}
/** Lead offers or pushes email as contact method mid-funnel (not unrelated email mention). */
function isEmailDeflection(text) {
    if (signalsEmailDeliveryRequest(text))
        return true;
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (/\byou can email me\b/.test(t))
        return true;
    if (/\bemail me\b/.test(t) && /\b(at|@|instead|rather|prefer)\b/.test(t))
        return true;
    if (/\b(i prefer|i'd prefer|id prefer|rather use)\s+email\b/.test(t))
        return true;
    if (/\b(send|reach).{0,20}\bemail\b/.test(t) && /\b(instead|rather|prefer)\b/.test(t))
        return true;
    return false;
}
/** Commission rebate question tied to new construction purchase (pre-phone Bucket F). */
function asksAboutCommissionRebate(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    // "rebates?" (not just "rebate") — plural forms like "commission rebates"
    // were silently failing the trailing \b against the "s", never matching.
    const rebateIntent = /\b(rebates?|commission rebates?|buyer agent commission|agent commission|commission back)\b/.test(t);
    if (!rebateIntent)
        return false;
    const newConstruction = /\b(new construction|new build|new home|new house|builder|build from scratch|custom build|preconstruction|pre-construction|new development)\b/.test(t);
    if (newConstruction)
        return true;
    if (/\b(rebates?|commission).{0,48}\b(purchase|buy|build|construction|new)\b/.test(t))
        return true;
    if (/\b(purchase|buy|build|construction|new).{0,48}\b(rebates?|commission)\b/.test(t))
        return true;
    return false;
}
/**
 * Bucket F: call-ask escalation, retry counting, graceful exit, call-agreement → number ask.
 * Returns null when graceful exit already sent or no trigger matches.
 */
function resolveCallAskBucketF(conversation, latestText) {
    if (threadContainsGracefulCallAskExit(conversation))
        return null;
    if (lastAssistantWasCallAsk(conversation) && signalsCallAskAgreement(latestText)) {
        return { kind: "number_ask", reply: prompts_js_1.MARCO_CALL_NUMBER_ASK_REPLY };
    }
    let triggerReply = null;
    if (isInStateConfirmation(latestText)) {
        triggerReply = prompts_js_1.MARCO_CALL_ASK_INSTATE;
    }
    else if (isEmailDeflection(latestText)) {
        triggerReply = prompts_js_1.MARCO_CALL_ASK_EMAIL_DEFLECT;
    }
    else if (asksAboutCommissionRebate(latestText)) {
        triggerReply = prompts_js_1.MARCO_REBATE_REPLY;
    }
    if (!triggerReply)
        return null;
    if (countCallAskAttempts(conversation) >= exports.MAX_CALL_ASK_ATTEMPTS) {
        return { kind: "graceful_exit", reply: prompts_js_1.MARCO_CALL_ASK_GRACEFUL_EXIT };
    }
    return { kind: "call_ask", reply: triggerReply };
}
const ACK_PHRASE_TOKENS = new Set([
    "thanks",
    "thank",
    "you",
    "so",
    "much",
    "very",
    "ok",
    "okay",
    "got",
    "it",
    "sounds",
    "good",
    "perfect",
    "awesome",
    "alright",
    "cool",
    "great",
    "nice",
    "thx",
    "ty",
    "again",
    "appreciate",
    "wonderful",
    "sweet",
    "lovely",
    "a",
    "lot",
]);
const ACK_ONLY_PATTERNS = [
    /^thanks?( so much| very much| a lot| again)?$/,
    /^thank you( so much| very much| again)?$/,
    /^ok(ay)?( thanks?| thank you| thx)?$/,
    /^(got it|sounds good|perfect|awesome|alright|cool|great|nice|sweet|lovely|wonderful)( thank you| thanks?| so much)?$/,
    /^(perfect|awesome|alright|cool|great)\s+(thank you|thanks)( so much)?$/,
    /^appreciate it$/,
    /^(bye(bye)?|goodbye|cya|ttyl|later|gotta go)[!.?]*$/,
    /^(you too|u too)[!.?]*$/,
    /^(take care|have a good (day|night|one)|talk (to you )?later|catch you later)[!.?]*$/,
];
/**
 * Short closing phrase with no question — thanks, ok thanks, got it, etc.
 * Question marks, question words, or non-ack content → false (treat as a real message).
 */
function isAcknowledgmentOnly(text) {
    const raw = text.trim();
    if (!raw)
        return false;
    if (raw.includes("?"))
        return false;
    const lower = raw.toLowerCase();
    if (/\b(what|when|where|how|why|who|does|is|can|could|would|will|are|have|did|was|were)\b/.test(lower)) {
        return false;
    }
    const normalized = lower.replace(/[!.,…]+/g, " ").replace(/\s+/g, " ").trim();
    if (ACK_ONLY_PATTERNS.some((p) => p.test(normalized)))
        return true;
    const tokens = normalized.split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || tokens.length > 6)
        return false;
    return tokens.every((tok) => ACK_PHRASE_TOKENS.has(tok));
}
/**
 * Shared pre- and post-phone path: ack-only lead line after Marco has spoken.
 * Skip when the number was captured on this same inbound turn (phone confirm handles that).
 */
function resolveAcknowledgmentCloseoutTurn(conversation, latestText, closeoutLine, options) {
    if (options.skipIfPhoneCapturedThisTurn)
        return null;
    if (!isAcknowledgmentOnly(latestText))
        return null;
    const hasMarcoOutbound = conversation.messages.some((m) => m.role === "assistant" && m.text?.trim());
    if (!hasMarcoOutbound)
        return null;
    if (lastAssistantMessageMatches(conversation, closeoutLine))
        return "silence";
    return "closeout";
}
/**
 * True if Marco's last two outbound messages are the same or nearly the same (stuck loop).
 */
function lastTwoAssistantMessagesAreDuplicate(conversation) {
    const assistant = [];
    for (const m of conversation.messages) {
        if (m.role === "assistant" && m.text?.trim())
            assistant.push(m.text.trim());
    }
    if (assistant.length < 2)
        return false;
    const last = assistant[assistant.length - 1];
    const prev = assistant[assistant.length - 2];
    return messagesAreSubstantiallyDuplicate(last, prev);
}
/**
 * True if the most recent Marco outbound substantially matches ANY earlier Marco line (catches A→B→A loops).
 */
function latestAssistantEchoesEarlierInThread(conversation) {
    const assistant = [];
    for (const m of conversation.messages) {
        if (m.role === "assistant" && m.text?.trim())
            assistant.push(m.text.trim());
    }
    if (assistant.length < 2)
        return false;
    const last = assistant[assistant.length - 1];
    for (let i = 0; i < assistant.length - 1; i++) {
        if (messagesAreSubstantiallyDuplicate(last, assistant[i]))
            return true;
    }
    return false;
}
/** Thread already contains Marco's agent question (used for deterministic funnel escape). */
function threadContainsAgentQuestion(conversation) {
    return conversation.messages.some((m) => m.role === "assistant" && /\bworking with an agent\b/i.test(m.text));
}
/**
 * Any Marco line already asked the TikTok-style first-time-through-the-buying-process question
 * (manual DM or AI). Used to block repeating that opener in later turns.
 */
function threadContainsFirstTimeBuyingQuestion(conversation) {
    return conversation.messages.some((m) => m.role === "assistant" && isFirstTimeBuyingOpener(m.text ?? ""));
}
/** A single Marco line is the first-time-through-the-buying-process opener. */
function isFirstTimeBuyingOpener(text) {
    const t = text?.trim();
    if (!t)
        return false;
    if (!/\bfirst\s*time\b/i.test(t) && !/\bfirst-time\b/i.test(t))
        return false;
    if (!/\b(buying|buy)\b/i.test(t))
        return false;
    return /\bprocess\b/i.test(t) || /\bgoing\s+through\b/i.test(t);
}
/** Lead already indicated they are not a first-time buyer (thread-wide). */
function leadThreadSignalsExperiencedBuyer(conversation) {
    for (const m of conversation.messages) {
        if (m.role !== "user" || !m.text?.trim())
            continue;
        const t = m.text;
        if (/\bnot\s+my\s+first\b/i.test(t))
            return true;
        if (/\b(we|i)('?ve?| have)\s+(both\s+)?(bought|owned|purchased)\b/i.test(t))
            return true;
        if (/\bbought\s+(two|2|three|3|several|a few|multiple)\s+(homes?|houses?|properties)\b/i.test(t)) {
            return true;
        }
        if (/\bsecond\s+(home|house)\b/i.test(t))
            return true;
        if (/^\s*no\b/i.test(t) && /\b(own|owned|bought|house|home|properties)\b/i.test(t))
            return true;
        if (/\b(we|i)\s+also\s+own\b/i.test(t))
            return true;
        if (/\bcurrently\s+own\b/i.test(t))
            return true;
    }
    return false;
}
/** Lead is asking price / cost for the listing (TikTok: never answer in DM). */
function messageAsksPropertyPriceOrCost(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    const pointsAtListing = /\b(it|this|that|the (house|home|place|property|listing|one)|video|that home|this home)\b/.test(t);
    if (/\bhow much\b/.test(t) &&
        !/\bhow much (can|do) (you|i) (afford|need)\b/.test(t) &&
        !/\bhow much (room|space|time|land|acre)\b/.test(t)) {
        return true;
    }
    if (/\bwhat'?s?\s+the\s+(price|cost)\b/.test(t))
        return true;
    if (/\bhow much is (it|this|that|the (house|home|place))\b/.test(t))
        return true;
    if (/\bis it (expensive|cheap|affordable)\b/.test(t))
        return true;
    if (pointsAtListing && /\b(price|cost|pricing)\b/.test(t) && /\b(what|how much|is)\b/.test(t))
        return true;
    if (/^\s*(price|pricing|cost)\s*[!.?]*\s*$/i.test(t))
        return true;
    if (/\bashing\s+price\b/.test(t))
        return true;
    return false;
}
/** Lead wants details or the packet kept in app DM only, not SMS (resistance to giving a number). */
function signalsWantsInfoInDmOnly(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (/\byou can send (it|them|that|everything|the info|details) here\b/.test(t))
        return true;
    if (/\bsend (it|them|that|everything) here\b/.test(t))
        return true;
    if (/\bkeep (it )?in (the )?(dm|chat)\b/.test(t))
        return true;
    if (/\b(all )?in (the )?dm\b/.test(t) && /\b(send|stay|keep|want)\b/.test(t))
        return true;
    if (/\bhere in (the )?(dm|chat)\b/.test(t))
        return true;
    if (/\bhere is fine\b/.test(t))
        return true;
    if (/\bthis is fine\b/.test(t))
        return true;
    if (/\bin here is fine\b/.test(t))
        return true;
    if (/\b(here|in the (dm|dms|chat)|in here|on here) is (fine|good|ok|okay|cool)\b/.test(t))
        return true;
    if (/\b(fine|good|ok|okay|cool|works) (here|in here|on here|in the (dm|dms|chat))\b/.test(t))
        return true;
    if (/\bjust (here|in the (dm|dms|chat)|in here)\b/.test(t))
        return true;
    if (/\b(send|put|drop) (it|that|everything|the (info|details|breakdown)) (here|in here|in the (dm|dms|chat))\b/.test(t)) {
        return true;
    }
    if (/\b(i want|want) (it|that|the (info|details|breakdown)) (here|in the (dm|dms|chat))\b/.test(t))
        return true;
    if (/\b(let'?s|we can) keep it (on here|here|in the (dm|dms|chat))\b/.test(t))
        return true;
    if (/\bprefer (to get|getting|it) (here|in the (dm|dms|chat))\b/.test(t))
        return true;
    if (/\b(in the app|on the app|in this chat|in this thread) is (fine|good|ok)\b/.test(t))
        return true;
    return false;
}
/** Lead is pushing urgency after phone capture (wants breakdown immediately). */
function signalsWantsBreakdownImmediately(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (/\basap\b/.test(t))
        return true;
    if (/\bright now\b/.test(t))
        return true;
    if (/\b(need|want)\s+it\s+now\b/.test(t))
        return true;
    if (/\bsend\s+(it|that|everything|the breakdown|the packet)\s+now\b/.test(t))
        return true;
    if (/\bimmediately\b/.test(t))
        return true;
    if (/\burgent\b/.test(t))
        return true;
    if (/\b(today|this morning|this afternoon)\b/.test(t) && /\b(send|need|want|asap)\b/.test(t))
        return true;
    return false;
}
/**
 * Lead is asking to receive the packet / details by email instead of text/DM.
 * Narrow patterns so "my email is …" does not trigger.
 */
function signalsEmailDeliveryRequest(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (/\bcan (you|we)\s+email\b/.test(t))
        return true;
    if (/\bcould you email\b/.test(t))
        return true;
    if (/\bare you able to email\b/.test(t))
        return true;
    if (/\bdo you mind emailing\b/.test(t))
        return true;
    if (/\bemail (me )?(the |this |it )?(info|information|details|packet|specs|materials|breakdown|list|sheet)\b/.test(t)) {
        return true;
    }
    if (/\bemail (it|this|that)\b/.test(t))
        return true;
    if (/\bsend (me )?(it|this|that|everything|the (info|information|details|packet))\s+(by|through|via|over|in)\s+email\b/.test(t)) {
        return true;
    }
    if (/\bsend (it|this|that)\s+to\s+(my\s+)?email\b/.test(t))
        return true;
    if (/\b(via|through|over|by)\s+email\b/.test(t) && /\b(send|get|receive|want|can you|could you)\b/.test(t)) {
        return true;
    }
    if (/\b(prefer|rather)\s+(it\s+)?(by|through)\s+email\b/.test(t))
        return true;
    // "you can share it with me on my email" / "share that to my email" — a
    // delivery preposition (on/to/via/through) right before "email" makes this
    // an unambiguous delivery request, not just "my email is …".
    if (/\bshare\b.{0,40}\b(on|to|via|through)\s+(my\s+)?email\b/.test(t))
        return true;
    return false;
}
/** Lead is asking for builder / developer identity (never disclose). */
function messageAsksBuilderIdentity(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (/\bwho\s+(built|builds)\b/.test(t))
        return true;
    if (/\bwho\s+is\s+the\s+(builder|developer)\b/.test(t))
        return true;
    if (/\bwhat('?s| is)\s+the\s+builder\b/.test(t))
        return true;
    if (/\bwhich\s+builder\b/.test(t))
        return true;
    if (/\b(builder|developer)\s+(name|is|for this|on this)\b/.test(t))
        return true;
    if (/\bwho'?s\s+the\s+builder\b/.test(t))
        return true;
    return false;
}
/** Lead text signals they are not represented / no agent (incl. "not working with anyone"). */
function leadTextSignalsNoAgent(text) {
    const t = text.toLowerCase();
    if (/\bno agent\b|\bnot an agent\b/.test(t))
        return true;
    if (/\bon my own\b|\bby myself\b/.test(t))
        return true;
    if (/\bnot\s+(currently\s+)?working\s+with\s+(anyone|anybody|an agent|a realtor|a broker)\b/.test(t)) {
        return true;
    }
    if (/\bdon'?t have an agent\b|\bwithout an agent\b/.test(t))
        return true;
    if (/\bnobody yet\b|\bno one yet\b/.test(t))
        return true;
    return false;
}
/**
 * True if candidate reply duplicates Marco's previous outbound (model stuck repeating).
 */
function isDuplicateMarcoReply(candidate, lastAssistant) {
    if (!lastAssistant?.trim() || !candidate.trim())
        return false;
    return messagesAreSubstantiallyDuplicate(candidate, lastAssistant);
}
/** True if candidate is substantially the same as any recent Marco outbound (anti-loop). */
function candidateMatchesRecentMarco(candidate, recentAssistantTexts) {
    if (!candidate.trim())
        return false;
    for (const prev of recentAssistantTexts) {
        if (messagesAreSubstantiallyDuplicate(candidate, prev))
            return true;
    }
    return false;
}
/**
 * True if the latest user message matches the immediately previous user message (normalized).
 */
function isLastUserMessageRepeated(conversation) {
    const userTexts = [];
    for (const m of conversation.messages) {
        if (m.role === "user") {
            userTexts.push(normalizeUserMessageText(m.text));
        }
    }
    if (userTexts.length < 2)
        return false;
    const last = userTexts[userTexts.length - 1];
    const prev = userTexts[userTexts.length - 2];
    if (!last || !prev)
        return false;
    if (last !== prev)
        return false;
    // Short duplicates like "yes"/"ok" twice — still let the funnel advance normally.
    if (last.length < 12)
        return false;
    return true;
}
/**
 * True if the lead is asking where *this* listing is (area, address, etc.).
 * Used so Marco only gives the approved hint (west of Stone Oak), not other regions.
 */
function messageAsksListingLocation(text) {
    const t = text.trim().toLowerCase();
    const pointsAtListing = /\b(it|this|that|the (house|home|place|property|listing))\b/.test(t) ||
        /\bwhere'?s it\b/.test(t) ||
        /\bwhere is it\b/.test(t);
    if (/\b(what'?s|what is) (the )?(address|location)\b/.test(t))
        return true;
    if (/\b(the )?address (for|of) (this|it|the|that)\b/.test(t))
        return true;
    if (/\bcross streets?\b/.test(t))
        return true;
    if (/\bwhere\b/.test(t) && pointsAtListing)
        return true;
    if (/\bhow far\b/.test(t) && pointsAtListing)
        return true;
    if (/\b(what|which) area\b/.test(t) && pointsAtListing)
        return true;
    if (/\bwhat neighborhood\b/.test(t) && pointsAtListing)
        return true;
    if (/\bwhat part of town\b/.test(t) && pointsAtListing)
        return true;
    if (/\bdo you know where\b/.test(t) && pointsAtListing)
        return true;
    if (/\blocated\b/.test(t) && pointsAtListing)
        return true;
    return false;
}
/**
 * Lead asks what city the property is in ("what city?", "which city is it?") without giving
 * enough context to match messageAsksListingLocation (no "it", "this", "the house" pointer).
 */
function messageAsksWhatCity(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (/\b(what|which)\s+city\b/.test(t))
        return true;
    if (/\bin what city\b/.test(t))
        return true;
    if (/\bwhat city (is (it|this|that|the (house|home|property|listing)))\b/.test(t))
        return true;
    return false;
}
/**
 * Lead is shopping / searching for a home outside San Antonio (another Texas market or explicit "not SA").
 * Triggers Marco's Texas-wide service line ($600k+) without claiming SA-only coverage for that buyer.
 */
function signalsLookingOutsideSanAntonio(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    const explicitOutsideSa = /\b(outside|outside of|not in|not around|away from|other than)\s+(san antonio|\bsa\b)\b/.test(t) ||
        /\b(not|isn't|is not)\s+(really\s+)?(in\s+)?san antonio\b/.test(t) ||
        /\b(home|house|buy|buying|looking).{0,60}\b(outside|not in).{0,30}\bsan antonio\b/.test(t);
    if (explicitOutsideSa)
        return true;
    // Major Texas metros / markets outside SA proper (not exhaustive; catches common DMs)
    const txMarket = /\b(austin|dallas|houston|fort worth|ft\.?\s*worth|el paso|corpus christi|plano|frisco|mckinney|arlington|laredo|lubbock|amarillo|waco|midland|odessa|tyler|new braunfels|round rock|katy|spring tx|pearland|sugar land|college station|killeen|beaumont|abilene|wichita falls|brownsville|pasadena tx|mesquite|denton|carrollton|lewisville|allen|richardson|conroe|georgetown tx|cedar park|san marcos tx)\b/i.test(t);
    const housingIntent = /\b(looking|search|buy|buying|home|house|move|relocat|market|area|city|live in|moving to)\b/i.test(t);
    const sanAntonioPrimary = /\b(in|around|near)\s+san antonio\b/.test(t) ||
        /\bsan antonio\b.{0,40}\b(looking|buy|home|house)\b/.test(t) ||
        /\b(sa|san antonio)\s+(area|market|homes)\b/.test(t);
    if (txMarket && housingIntent && !sanAntonioPrimary)
        return true;
    return false;
}
const US_STATES_EXCEPT_TEXAS = new Set([
    "alabama",
    "alaska",
    "arizona",
    "arkansas",
    "california",
    "colorado",
    "connecticut",
    "delaware",
    "florida",
    "georgia",
    "hawaii",
    "idaho",
    "illinois",
    "indiana",
    "iowa",
    "kansas",
    "kentucky",
    "louisiana",
    "maine",
    "maryland",
    "massachusetts",
    "michigan",
    "minnesota",
    "mississippi",
    "missouri",
    "montana",
    "nebraska",
    "nevada",
    "new hampshire",
    "new jersey",
    "new mexico",
    "new york",
    "north carolina",
    "north dakota",
    "ohio",
    "oklahoma",
    "oregon",
    "pennsylvania",
    "rhode island",
    "south carolina",
    "south dakota",
    "tennessee",
    "utah",
    "vermont",
    "virginia",
    "washington",
    "west virginia",
    "wisconsin",
    "wyoming",
    "district of columbia",
    "dc",
]);
const STATE_ABBREVS_EXCEPT_TX = new Set([
    "al",
    "ak",
    "az",
    "ar",
    "ca",
    "co",
    "ct",
    "de",
    "fl",
    "ga",
    "hi",
    "id",
    "il",
    "in",
    "ia",
    "ks",
    "ky",
    "la",
    "me",
    "md",
    "ma",
    "mi",
    "mn",
    "ms",
    "mo",
    "mt",
    "ne",
    "nv",
    "nh",
    "nj",
    "nm",
    "ny",
    "nc",
    "nd",
    "oh",
    "ok",
    "or",
    "pa",
    "ri",
    "sc",
    "sd",
    "tn",
    "ut",
    "vt",
    "va",
    "wa",
    "wv",
    "wi",
    "wy",
]);
/** Five-digit zip is outside Texas (TX: 750–799, 733, 885). */
function zipSignalsOutsideTexas(text) {
    const m = text.match(/\b(\d{5})(?:-\d{4})?\b/);
    if (!m)
        return false;
    const zip = m[1];
    const prefix3 = Number(zip.slice(0, 3));
    if (prefix3 >= 750 && prefix3 <= 799)
        return false;
    if (prefix3 === 733)
        return false;
    if (prefix3 === 885)
        return false;
    return true;
}
function signalsResidenceInTexas(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (/\b(texas|san antonio|\bsa\b)\b/.test(t) && /\b(in|live|living|based|from|moving to|relocat)\b/.test(t)) {
        return true;
    }
    if (/\b,\s*tx\b/.test(t) || /\btx\s*\d{5}\b/.test(t))
        return true;
    if (signalsLookingOutsideSanAntonio(text))
        return true;
    const txCity = /\b(austin|dallas|houston|fort worth|el paso|corpus christi|plano|frisco|new braunfels|san marcos)\b/i.test(t);
    const locPhrase = /\b(i'?m in|im in|we'?re in|were in|currently in|based in|living in|located in|from)\b/i.test(t);
    return txCity && locPhrase;
}
/**
 * True when the lead signals they are outside Texas (not another Texas market).
 * Ambiguous → not detected (caller continues normal funnel).
 */
function detectOutOfStateLead(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return { detected: false, regionLabel: null };
    if (signalsResidenceInTexas(text)) {
        return { detected: false, regionLabel: null };
    }
    const locPhrase = /\b(i'?m in|im in|we'?re in|were in|currently in|based in|living in|located in|moving from|relocat(?:ing)? from|from)\b/i.test(t);
    for (const state of US_STATES_EXCEPT_TEXAS) {
        if (new RegExp(`\\b${state.replace(/ /g, "\\s+")}\\b`, "i").test(t)) {
            const label = state
                .split(" ")
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(" ");
            return { detected: true, regionLabel: label };
        }
    }
    const abbrevMatch = t.match(/\b(?:in|from|based in|currently in|living in|located in)\s+([a-z]{2})\b/i);
    if (abbrevMatch) {
        const ab = abbrevMatch[1].toLowerCase();
        if (STATE_ABBREVS_EXCEPT_TX.has(ab)) {
            return { detected: true, regionLabel: ab.toUpperCase() };
        }
    }
    const nonTxCity = /\b(los angeles|san diego|san francisco|bakersfield|sacramento|fresno|long beach|oakland|seattle|portland|phoenix|tucson|denver|chicago|miami|orlando|tampa|jacksonville|atlanta|boston|nashville|charlotte|raleigh|las vegas|reno|philadelphia|pittsburgh|detroit|minneapolis|st\.? louis|kansas city|indianapolis|columbus|cincinnati|cleveland|milwaukee|baltimore|new york|brooklyn|newark)\b/i.test(t);
    if (nonTxCity && locPhrase) {
        return { detected: true, regionLabel: "your area" };
    }
    if (zipSignalsOutsideTexas(t) && locPhrase) {
        return { detected: true, regionLabel: "your area" };
    }
    return { detected: false, regionLabel: null };
}
/** Marco already sent the out-of-state referral offer in this thread. */
function threadContainsReferralOffer(conversation) {
    return conversation.messages.some((m) => m.role === "assistant" &&
        /\b(link you up|connects with solid agents|connect you with)\b/i.test(m.text));
}
function signalsReferralAcceptance(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (/\b(no|nah|nope|not really|don'?t|dont)\b/.test(t) && !/\b(yes|yeah|sure)\b/.test(t)) {
        return false;
    }
    return (/^(yes|yeah|yep|yup|sure|ok|okay|please|absolutely|definitely)\b/.test(t) ||
        /\b(that would be great|sounds good|link me up|connect me|hook me up|yes please)\b/.test(t));
}
/** Lead declined referral or clarified they want San Antonio / Texas. */
function signalsReferralDeclineOrWantsSanAntonio(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (/\b(san antonio|\bsa\b|texas|tx)\b/.test(t) && /\b(looking|buy|move|relocat|want|interested)\b/.test(t)) {
        return true;
    }
    return (/^(no|nah|nope|not really)\b/.test(t) ||
        /\b(don'?t need|dont need|no thanks|not interested in a referral)\b/.test(t) ||
        /\b(actually|but)\b.{0,30}\b(san antonio|texas)\b/.test(t));
}
function buildOutOfStateReferralOffer(regionLabel) {
    const where = regionLabel && regionLabel !== "your area" ? regionLabel : "your area";
    return (`Oh got it, so you're out in ${where}. We actually work exclusively in the San Antonio area but I got connects with solid agents all over. ` +
        `Want me to link you up with someone in your area who can help?`);
}
exports.REFERRAL_AREA_FOLLOW_UP = "Cool, what area exactly are you looking in? I'll get you connected with the right person";
/** Count assistant messages since the last user message (0 when thread ends with user). */
function countAssistantsSinceLastUser(conversation) {
    let n = 0;
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
        if (conversation.messages[i].role === "user")
            break;
        if (conversation.messages[i].role === "assistant")
            n++;
    }
    return n;
}
/** Consecutive assistant messages at the end of the thread (no user after them). */
function countTrailingAssistantsAtEnd(conversation) {
    let n = 0;
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
        if (conversation.messages[i].role === "assistant")
            n++;
        else
            break;
    }
    return n;
}
/** Same short line twice (e.g. double-tap "yes") — do not treat as stuck/repeat for funnel logic. */
function isShortDuplicateUserPair(conversation) {
    const userTexts = [];
    for (const m of conversation.messages) {
        if (m.role === "user") {
            userTexts.push(normalizeUserMessageText(m.text));
        }
    }
    if (userTexts.length < 2)
        return false;
    const last = userTexts[userTexts.length - 1];
    const prev = userTexts[userTexts.length - 2];
    return last === prev && last.length < 12;
}
/**
 * Lead is explicitly and directly refusing to share their phone number.
 * Stronger/more direct than general phone resistance (isPhoneResistance) —
 * catches "I don't share my number", "I won't give my number", "sorry I don't
 * provide my phone number on TikTok", etc.
 */
function signalsExplicitPhoneRefusal(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (/\b(don'?t|do not|won'?t|will not)\s+(share|give|give out|provide)\s+(my\s+)?(phone\s+)?(number|phone)\b/.test(t))
        return true;
    if (/\b(i'?m not going to give|not giving (you|anyone)\s+(my\s+)?(phone|number))\b/.test(t))
        return true;
    if (/\bi (never|don'?t) give (out\s+)?(my\s+)?(phone|number)\b/.test(t))
        return true;
    // "I'm sorry I don't provide my phone number on TikTok"
    if (/\b(i'?m sorry|sorry|apologi)\b/.test(t) && /\b(don'?t|won'?t|not|no)\s+.{0,20}\b(phone|number)\b/.test(t))
        return true;
    if (/\b(not comfortable (with\s+)?(sharing|giving|providing)\s+(my\s+)?(phone|number))\b/.test(t))
        return true;
    if (/\b(prefer not to (share|give)\s+(my\s+)?(phone|number))\b/.test(t))
        return true;
    // Lead requesting DM / in-chat delivery — equivalent to refusing to give a number
    if (/\bcan (you|u) (just\s+)?(send|dm|message)\s*(it|that|the (info|breakdown|details))?\s*(here|in (the\s+)?(dm|dms?|chat|messages?|inbox))\b/.test(t))
        return true;
    if (/\bjust send (it|them|the info|everything|that|this)?\s*(here|in (the\s+)?(dm|dms?|chat|messages?))\b/.test(t))
        return true;
    if (/\b(send|give) it (to me )?(here|in (the\s+)?(dm|dms?|chat|messages?|inbox))\b/.test(t))
        return true;
    // Lead insisting on email delivery as substitute for phone — treated the same as phone refusal
    if (/^(just\s+)?(email\s+only|email\s+is\s+(fine|ok(ay)?|good|enough|best))\s*[.!?]*$/.test(t))
        return true;
    if (/^just\s+email\s*[.!?]*$/.test(t))
        return true;
    if (/\bemail\s+(only|is fine|is ok(ay)?|will (do|work|be enough|suffice)|is enough|works)\b/.test(t))
        return true;
    if (/\b(just|only)\s+email\s+(me\s+)?(will|is|works?)\b/.test(t))
        return true;
    if (/\bjust email (me|it|that|the|everything)\b/.test(t) && !/\b(my|their|his|her|your)\s+email\b/.test(t))
        return true;
    return false;
}
/** True if Marco already sent the phone refusal apology in this thread. */
function threadContainsPhoneRefusalApology(conversation) {
    return conversation.messages.some((m) => m.role === "assistant" &&
        m.text?.trim() &&
        messagesAreSubstantiallyDuplicate(m.text, prompts_js_1.MARCO_PHONE_REFUSAL_APOLOGY));
}
/**
 * DM is from a business pitcher (video editor, loan officer, marketer, collaborator)
 * trying to sell services to Marco — NOT a property buyer asking about a listing.
 */
function isBusinessPitchInquiry(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    // Video editor / content creator pitching services
    if (/\b(i'?m a |i am a |im a )(video editor|content creator|videographer|filmmaker)\b/.test(t))
        return true;
    if (/\bi (can edit|do editing|do video editing|edit videos?|create content|make content|produce content|film videos?)\b/.test(t) &&
        /\b(for (you|your|real estate)|i'?d love|work (with|together))\b/.test(t))
        return true;
    if (/\b(video editing|content creation|video production)\s+(services?|packages?|work)\b/.test(t) &&
        /\b(for (you|your|real estate|realtors?))\b/.test(t))
        return true;
    // Loan officer pitching to Marco (not a buyer referencing their own financing)
    if (/\b(i'?m a |i am a |im a )(loan officer|mortgage (broker|officer|specialist|lender))\b/.test(t) &&
        /\b(i can help|work (with|together)|would love|reach out|realtors?|clients?)\b/.test(t))
        return true;
    if (/\b(i work with realtors?|i partner with realtors?)\b/.test(t) &&
        /\b(loan|mortgage|lending|financing)\b/.test(t))
        return true;
    // Marketing / social media / digital services pitch
    if (/\b(i('?m| am) a |im a )(social media (manager|specialist|expert)|digital marketer|marketing (consultant|specialist|expert))\b/.test(t) &&
        /\b(help|work|reach out|interested|services?)\b/.test(t))
        return true;
    if (/\b(grow your (brand|following|audience|business|page|account))\b/.test(t) &&
        /\b(i can|i (help|offer)|services?|work together)\b/.test(t))
        return true;
    if (/\b(marketing (services?|solutions?|packages?)|social media (management|marketing) (services?|packages?))\b/.test(t) &&
        /\b(for (you|your|real estate|realtors?))\b/.test(t))
        return true;
    // Collaboration / partnership / business opportunity pitch
    if (/\b(business (collab(oration)?|partnership|opportunity|proposal))\b/.test(t) &&
        /\b(i'?d love|would love|interested in|reaching out|potential)\b/.test(t))
        return true;
    if (/\b(i'?d love to collaborate|would love to collaborate|i'?d love to partner|would love to partner)\b/.test(t))
        return true;
    if (/\b(potential (collab(oration)?|partnership|business opportunity))\b/.test(t))
        return true;
    return false;
}
/**
 * Lead is confused about what the first-time-buying opener referred to.
 * Marco often sends that opener manually with no property context, so a lead who never
 * mentioned buying replies "Buying of what?" / "buy what?" / "what do you mean?".
 * Only meaningful directly after that opener (see resolveBuyingConfusionReply).
 */
function signalsBuyingConfusion(text) {
    const t = text.trim().toLowerCase().replace(/[?!.]+$/, "").trim();
    if (!t)
        return false;
    if (t.length > 60)
        return false;
    // "buying of what", "buying what", "buy what", "purchasing what"
    if (/\b(buying|buy|purchas(e|ing))\b\s*(of\s+)?\bwhat\b/.test(t))
        return true;
    if (/^what\s+(am\s+i|are\s+we|are\s+you)\s+(buying|purchasing)\b/.test(t))
        return true;
    // bare confusion right after the opener
    if (/^(what|huh|wdym|what'?s this (about|regarding))$/.test(t))
        return true;
    if (/^what\s+do\s+you\s+mean\b/.test(t))
        return true;
    if (/^(what|which)\s+(process|house|home|property)\b/.test(t))
        return true;
    // Outright denials ("I didn't inquire", "wrong person") are not confusion: isDenialOfInquiry
    // owns those earlier in the pipeline and sends the goodbye reply instead.
    return false;
}
/**
 * Marco's most recent line was the first-time-buying opener and the lead came back confused.
 * Returns the re-anchor reply, or null when this turn is not that situation.
 */
function resolveBuyingConfusionReply(conversation, latestLeadText) {
    if (!signalsBuyingConfusion(latestLeadText))
        return null;
    const lastAssistant = getLastAssistantMessageText(conversation);
    if (!lastAssistant || !isFirstTimeBuyingOpener(lastAssistant))
        return null;
    // Only re-anchor once; if we already apologized, let the LLM carry it forward.
    const alreadySent = conversation.messages.some((m) => m.role === "assistant" && m.text?.trim() &&
        messagesAreSubstantiallyDuplicate(m.text, prompts_js_1.MARCO_BUYING_CONFUSION_REPLY));
    if (alreadySent)
        return null;
    return prompts_js_1.MARCO_BUYING_CONFUSION_REPLY;
}
/**
 * Lead asserts they already sent their number ("I just gave them to you").
 * Distinct from resistance: they think they complied, so re-asking cold reads as not listening.
 */
function claimsAlreadySentNumber(text) {
    const t = text.trim().toLowerCase();
    if (!t)
        return false;
    if (!/\b(number|digits|phone|it|them|that)\b/.test(t))
        return false;
    if (/\b(just|already)\s+(gave|sent|texted|typed|put|shared|posted)\b/.test(t))
        return true;
    if (/\bi\s+(gave|sent|shared)\s+(it|them|you|that|my number|the number)\b/.test(t))
        return true;
    if (/\b(sent|gave)\s+(it|them|that|my number|the number)\s+(to you|already|above|earlier)\b/.test(t))
        return true;
    if (/\b(it'?s|its|thats|that'?s)\s+(right\s+)?(there|above|up there)\b/.test(t))
        return true;
    if (/\b(did|didn'?t)\s+you\s+(get|see)\s+(it|them|my number|the number)\b/.test(t))
        return true;
    return false;
}
/** Count of number-not-received recovery lines already sent in this thread. */
function countNumberNotReceivedReplies(conversation) {
    return countAssistantMessagesMatchingAny(conversation, [...prompts_js_1.MARCO_NUMBER_NOT_RECEIVED_REPLIES]);
}
/**
 * Lead says they already sent a number but nothing was captured. Alternates Carlos's two
 * phrasings, then returns null so the thread falls through to the LLM instead of looping.
 */
function resolveNumberNotReceivedReply(conversation) {
    const sent = countNumberNotReceivedReplies(conversation);
    if (sent >= prompts_js_1.MARCO_NUMBER_NOT_RECEIVED_REPLIES.length)
        return null;
    return prompts_js_1.MARCO_NUMBER_NOT_RECEIVED_REPLIES[sent];
}
