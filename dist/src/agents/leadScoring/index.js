"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WEIGHTS = void 0;
exports.calculateLeadScore = calculateLeadScore;
exports.getTierForScore = getTierForScore;
exports.scoreAndRecordLead = scoreAndRecordLead;
exports.scoreAllLeads = scoreAllLeads;
exports.scoreColdLeads = scoreColdLeads;
exports.checkAndRunAutoRescoreIfDue = checkAndRunAutoRescoreIfDue;
exports.scheduleAutoRescore = scheduleAutoRescore;
const db_js_1 = require("../../core/db.js");
const smsStore_js_1 = require("../../core/smsStore.js");
const leadScoreStore_js_1 = require("../../core/leadScoreStore.js");
const hotLeadFlow_js_1 = require("../leadNurture/hotLeadFlow.js");
/** Weights sum to 100. Timeline + pre-approval need manual CRM fields to score > 0. */
exports.WEIGHTS = {
    timeline: 25,
    preApproval: 25,
    responseCount: 20,
    propertyViews: 15,
    showingRequests: 15,
};
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
function scoreTimeline(lead) {
    const timeline = (lead.criteria?.timeline ?? "").toLowerCase().trim();
    if (!timeline)
        return 0;
    if (/asap|immediately|now|this month|urgent/.test(timeline))
        return exports.WEIGHTS.timeline;
    if (/1-3 months|soon|next few months|1 to 3/.test(timeline))
        return Math.round(exports.WEIGHTS.timeline * 0.7);
    if (/3-6 months|3 to 6/.test(timeline))
        return Math.round(exports.WEIGHTS.timeline * 0.4);
    if (/6\+|6 plus|just looking|exploring|no rush/.test(timeline))
        return Math.round(exports.WEIGHTS.timeline * 0.1);
    return Math.round(exports.WEIGHTS.timeline * 0.3);
}
function scorePreApproval(lead) {
    const status = lead.preApprovalStatus;
    if (!status)
        return 0;
    if (status === "approved" || status === "cash")
        return exports.WEIGHTS.preApproval;
    if (status === "in_progress")
        return Math.round(exports.WEIGHTS.preApproval * 0.5);
    if (status === "not_approved")
        return Math.round(exports.WEIGHTS.preApproval * 0.1);
    return 0;
}
/**
 * How engaged this lead is, measured on the channel they actually used.
 *
 * This read `sms_threads` alone, which is why every one of 1,306 leads scored
 * 0/100 and the board showed ZERO hot leads: Twilio is not configured in
 * production, so that table is empty, while the entire funnel runs on Instagram
 * and TikTok DMs. A lead who had replied fifteen times scored the same as one
 * who never answered. Twenty of the hundred points were dead.
 *
 * Both channels now count, and the higher wins rather than the sum: a lead who
 * moved from DM to text is one conversation, not two, and adding them would
 * quietly reward channel-switching over actual interest.
 */
function scoreResponseCount(leadId) {
    let sms = 0;
    try {
        sms = (0, smsStore_js_1.getInboundMessageCount)(leadId);
    }
    catch {
        /* No SMS store configured is not a reason to score the DM history at zero. */
    }
    const inboundCount = Math.max(sms, (0, db_js_1.getInboundDmCount)(leadId));
    if (inboundCount === 0)
        return 0;
    if (inboundCount <= 2)
        return Math.round(exports.WEIGHTS.responseCount * 0.4);
    if (inboundCount <= 5)
        return Math.round(exports.WEIGHTS.responseCount * 0.7);
    return exports.WEIGHTS.responseCount;
}
function countPropertyInterestSignals(lead) {
    const manual = typeof lead.propertyViewsCount === "number" && lead.propertyViewsCount > 0
        ? lead.propertyViewsCount
        : 0;
    const fromActivity = (lead.activity ?? []).filter((a) => ["home_clicked", "home_hearted", "web_visit"].includes(a.type)).length;
    return Math.max(manual, fromActivity);
}
function scorePropertyViews(lead) {
    const views = countPropertyInterestSignals(lead);
    if (views === 0)
        return 0;
    if (views <= 2)
        return Math.round(exports.WEIGHTS.propertyViews * 0.5);
    return exports.WEIGHTS.propertyViews;
}
function scoreShowingRequests(lead) {
    if (!lead.showingAppointment)
        return 0;
    if (lead.showingAppointment.confirmationStatus === "confirmed")
        return exports.WEIGHTS.showingRequests;
    if (lead.showingAppointment.confirmationStatus === "pending") {
        return Math.round(exports.WEIGHTS.showingRequests * 0.7);
    }
    return Math.round(exports.WEIGHTS.showingRequests * 0.3);
}
function calculateLeadScore(lead) {
    const factors = {
        timeline: scoreTimeline(lead),
        preApproval: scorePreApproval(lead),
        responseCount: scoreResponseCount(lead.id),
        propertyViews: scorePropertyViews(lead),
        showingRequests: scoreShowingRequests(lead),
    };
    const score = Object.values(factors).reduce((sum, v) => sum + v, 0);
    return { score: Math.min(100, score), factors };
}
function getTierForScore(score) {
    if (score >= 80)
        return "hot";
    if (score >= 40)
        return "warm";
    return "cold";
}
function scoreAndRecordLead(lead) {
    const previous = (0, leadScoreStore_js_1.getLatestScore)(lead.id);
    const { score, factors } = calculateLeadScore(lead);
    const tier = getTierForScore(score);
    (0, leadScoreStore_js_1.recordLeadScore)({
        leadId: lead.id,
        score,
        previousScore: previous?.score,
        scoreDate: new Date().toISOString(),
        scoringFactors: factors,
        tier,
    });
    const tierChanged = previous ? previous.tier !== tier : true;
    if (tier === "hot" && (!previous || previous.tier !== "hot")) {
        (0, hotLeadFlow_js_1.triggerHotLeadAlert)(lead, score, factors).catch((err) => console.error("[HotLeadFlow]", err));
    }
    return { score, tier, previousScore: previous?.score, tierChanged };
}
async function scoreAllLeads() {
    const leads = await (0, db_js_1.listAllLeads)();
    let hot = 0;
    let warm = 0;
    let cold = 0;
    for (const lead of leads) {
        const { tier } = scoreAndRecordLead(lead);
        if (tier === "hot")
            hot++;
        else if (tier === "warm")
            warm++;
        else
            cold++;
    }
    console.log("[LeadScoring] Scored", leads.length, "leads —", hot, "hot,", warm, "warm,", cold, "cold");
    return { scored: leads.length, hot, warm, cold };
}
async function scoreColdLeads() {
    const coldScores = (0, leadScoreStore_js_1.getLeadsByTier)("cold");
    let rescored = 0;
    let promoted = 0;
    for (const scoreEntry of coldScores) {
        const lead = await (0, db_js_1.getLeadById)(scoreEntry.leadId);
        if (!lead)
            continue;
        const { tier } = scoreAndRecordLead(lead);
        rescored++;
        if (tier !== "cold")
            promoted++;
    }
    console.log("[AutoRescore] Re-scored", rescored, "cold leads —", promoted, "promoted out of cold");
    return { rescored, promoted };
}
async function checkAndRunAutoRescoreIfDue() {
    const lastRunAt = (0, leadScoreStore_js_1.getLastRescoreRunAt)();
    if (lastRunAt && Date.now() - new Date(lastRunAt).getTime() < THIRTY_DAYS_MS) {
        return { ran: false };
    }
    const result = await scoreColdLeads();
    (0, leadScoreStore_js_1.recordRescoreRun)(new Date().toISOString());
    return { ran: true, result };
}
let lastAutoRescoreCheckDate = null;
function scheduleAutoRescore() {
    const checkAndRun = () => {
        const now = new Date();
        const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago",
            hour: "numeric",
            minute: "numeric",
            hour12: false,
        }).formatToParts(now);
        const hour = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
        const minute = Number(parts.find((p) => p.type === "minute")?.value ?? -1);
        if (hour === 9 && minute >= 0 && minute < 2 && lastAutoRescoreCheckDate !== dateStr) {
            lastAutoRescoreCheckDate = dateStr;
            checkAndRunAutoRescoreIfDue().catch((err) => console.error("[AutoRescore]", err));
        }
    };
    setInterval(checkAndRun, 60 * 1000);
    console.log("[AutoRescore] Scheduled — checks daily at 9am Central, fires every 30 days");
}
