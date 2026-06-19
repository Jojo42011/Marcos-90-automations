"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectSocialSection = collectSocialSection;
exports.collectEmailSection = collectEmailSection;
exports.collectTextsSection = collectTextsSection;
exports.collectTransactionsSection = collectTransactionsSection;
exports.collectPipelineSection = collectPipelineSection;
exports.collectBusinessHealthSection = collectBusinessHealthSection;
const socialStore_js_1 = require("../../core/socialStore.js");
const index_js_1 = require("./index.js");
const smsStore_js_1 = require("../../core/smsStore.js");
const transactionsStore_js_1 = require("../../core/transactionsStore.js");
const db_js_1 = require("../../core/db.js");
const leadScoreStore_js_1 = require("../../core/leadScoreStore.js");
const index_js_2 = require("../leadScoring/index.js");
const centralTime_js_1 = require("./centralTime.js");
function videoCaption(v) {
    return (v.caption || "").trim();
}
function videoScore(v) {
    return v.scoreBreakdown?.score ?? v.score ?? 0;
}
function collectSocialSection() {
    try {
        const data = (0, socialStore_js_1.getLatestSocialDashboardData)();
        const videos = data.videos || [];
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const recentVideos = videos.filter((v) => new Date(v.postedAt || 0).getTime() >= sevenDaysAgo);
        const avgViews = recentVideos.length > 0
            ? Math.round(recentVideos.reduce((s, v) => s + (v.views || 0), 0) / recentVideos.length)
            : data.summary?.avgViews ?? 0;
        const sorted = [...videos].sort((a, b) => (b.views || 0) - (a.views || 0));
        const top = sorted[0];
        const topPost = top
            ? {
                description: videoCaption(top).substring(0, 80),
                views: top.views || 0,
                score: videoScore(top),
            }
            : null;
        const morning = (0, socialStore_js_1.getLatestMorningScanFromDb)();
        const evening = (0, index_js_1.getLatestReportingSnapshot)("evening");
        let followersChangeWeek = 0;
        if (evening?.data && typeof evening.data === "object") {
            const prevFollowers = evening.data.followerCount;
            if (typeof prevFollowers === "number" && data.profile?.followers) {
                followersChangeWeek = data.profile.followers - prevFollowers;
            }
        }
        return {
            followers: data.profile?.followers ?? 0,
            followersChangeWeek,
            avgViewsLast7Days: avgViews,
            topPost,
            newDmLeads: morning?.newComments ?? 0,
            leadIntentFlags: morning?.leadIntentFlags?.length ?? 0,
        };
    }
    catch (err) {
        console.error("[Reporting] Social section error:", err);
        return {
            followers: 0,
            followersChangeWeek: 0,
            avgViewsLast7Days: 0,
            topPost: null,
            newDmLeads: 0,
            leadIntentFlags: 0,
        };
    }
}
async function collectEmailSection() {
    try {
        const { getEmailStats, countActiveDripSequences } = await Promise.resolve().then(() => __importStar(require("../../core/emailStore.js")));
        const todayStart = (0, centralTime_js_1.startOfCentralDayIso)();
        const stats = getEmailStats(todayStart);
        const openRate = stats.sent > 0 ? Math.round((stats.opened / stats.sent) * 100) / 100 : null;
        return {
            sent: stats.sent,
            openRate,
            replies: stats.replied,
            sequences: countActiveDripSequences(),
            gap: stats.sent === 0 ? "No emails sent yet today." : "",
        };
    }
    catch (err) {
        console.error("[Reporting] Email section error:", err);
        return { sent: 0, openRate: null, replies: 0, sequences: 0, gap: "Email data unavailable." };
    }
}
async function collectTextsSection() {
    try {
        const db = (0, smsStore_js_1.getSmsDb)();
        const todayStartIso = (0, centralTime_js_1.startOfCentralDayIso)();
        const sentRow = db
            .prepare(`SELECT COUNT(*) AS count FROM sms_threads WHERE direction = 'outbound' AND sent_at >= ?`)
            .get(todayStartIso);
        const receivedRow = db
            .prepare(`SELECT COUNT(*) AS count FROM sms_threads WHERE direction = 'inbound' AND sent_at >= ?`)
            .get(todayStartIso);
        const sentToday = Number(sentRow.count) || 0;
        const receivedToday = Number(receivedRow.count) || 0;
        const replyRate = sentToday > 0 ? Math.round((receivedToday / sentToday) * 100) / 100 : 0;
        const leads = await (0, db_js_1.listAllLeads)();
        const appointmentsBooked = leads.filter((l) => {
            if (!l.showingAppointment?.scheduledAt)
                return false;
            return new Date(l.showingAppointment.scheduledAt).getTime() >= new Date(todayStartIso).getTime();
        }).length;
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const activeRow = db
            .prepare(`SELECT COUNT(DISTINCT lead_id) AS count FROM sms_threads WHERE sent_at >= ?`)
            .get(sevenDaysAgo);
        return {
            sentToday,
            receivedToday,
            replyRate,
            appointmentsBooked,
            activeThreads: Number(activeRow.count) || 0,
        };
    }
    catch (err) {
        console.error("[Reporting] Texts section error:", err);
        return {
            sentToday: 0,
            receivedToday: 0,
            replyRate: 0,
            appointmentsBooked: 0,
            activeThreads: 0,
        };
    }
}
function collectTransactionsSection() {
    try {
        const all = (0, transactionsStore_js_1.getAllTransactions)();
        const dealsInEscrow = all.filter((t) => t.status === "under_contract").length;
        const now = Date.now();
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        const closingsThisWeek = all.filter((t) => t.closingDate &&
            new Date(t.closingDate).getTime() >= now &&
            new Date(t.closingDate).getTime() <= now + sevenDaysMs).length;
        const upcoming = (0, transactionsStore_js_1.getUpcomingDeadlines)(2);
        const deadlinesIn48Hours = upcoming.map((d) => {
            const tx = all.find((t) => t.id === d.dealId);
            return {
                address: tx?.address || "Unknown",
                label: d.label || d.deadlineType,
                dueDate: d.dueDate,
            };
        });
        const missedDeadlines = (0, transactionsStore_js_1.getOverdueDeadlines)().length;
        return { dealsInEscrow, closingsThisWeek, deadlinesIn48Hours, missedDeadlines };
    }
    catch (err) {
        console.error("[Reporting] Transactions section error:", err);
        return { dealsInEscrow: 0, closingsThisWeek: 0, deadlinesIn48Hours: [], missedDeadlines: 0 };
    }
}
async function collectPipelineSection() {
    try {
        const todayStartIso = (0, centralTime_js_1.startOfCentralDayIso)();
        const todayDateStr = (0, centralTime_js_1.centralDateString)();
        const leads = await (0, db_js_1.listAllLeads)();
        const newLeadsToday = leads.filter((l) => {
            if (!l.createdAt)
                return false;
            const createdCentral = new Intl.DateTimeFormat("en-CA", {
                timeZone: "America/Chicago",
            }).format(new Date(l.createdAt));
            return createdCentral === todayDateStr;
        }).length;
        const hotLeads = (0, leadScoreStore_js_1.getLeadsByTier)("hot").length;
        const warmLeads = (0, leadScoreStore_js_1.getLeadsByTier)("warm").length;
        const coldLeads = (0, leadScoreStore_js_1.getLeadsByTier)("cold").length;
        const tierMovements = (0, leadScoreStore_js_1.getScoreEntriesSince)(todayStartIso);
        let promotedToHotToday = 0;
        let goneColdToday = 0;
        for (const movement of tierMovements) {
            const prevTier = (0, index_js_2.getTierForScore)(movement.previousScore ?? 0);
            const newTier = movement.tier;
            if (newTier === "hot" && prevTier !== "hot")
                promotedToHotToday++;
            if (newTier === "cold" && prevTier !== "cold")
                goneColdToday++;
        }
        return {
            newLeadsToday,
            totalLeads: leads.length,
            hotLeads,
            warmLeads,
            coldLeads,
            promotedToHotToday,
            goneColdToday,
        };
    }
    catch (err) {
        console.error("[Reporting] Pipeline section error:", err);
        return {
            newLeadsToday: 0,
            totalLeads: 0,
            hotLeads: 0,
            warmLeads: 0,
            coldLeads: 0,
            promotedToHotToday: 0,
            goneColdToday: 0,
        };
    }
}
function transactionGci(price, commissionPercent) {
    if (!price || !Number.isFinite(price))
        return 0;
    const pct = commissionPercent ?? 3;
    return Math.round((price * pct) / 100);
}
function collectBusinessHealthSection() {
    try {
        const all = (0, transactionsStore_js_1.getAllTransactions)();
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const yearStart = new Date(now.getFullYear(), 0, 1);
        const pipelineGCI = all
            .filter((t) => ["active", "under_contract", "pending"].includes(t.status) && t.price)
            .reduce((sum, t) => sum + transactionGci(t.price, t.parties?.commissionPercent), 0);
        const mtdClosed = all.filter((t) => t.status === "closed" &&
            t.closingDate &&
            new Date(t.closingDate) >= monthStart);
        const mtdClosedVolume = mtdClosed.reduce((s, t) => s + (t.price || 0), 0);
        const mtdClosedGCI = mtdClosed.reduce((s, t) => s + transactionGci(t.price, t.parties?.commissionPercent), 0);
        const ytdClosed = all.filter((t) => t.status === "closed" &&
            t.closingDate &&
            new Date(t.closingDate) >= yearStart);
        const ytdClosedGCI = ytdClosed.reduce((s, t) => s + transactionGci(t.price, t.parties?.commissionPercent), 0);
        return {
            pipelineGCI: Math.round(pipelineGCI),
            mtdClosedVolume: Math.round(mtdClosedVolume),
            mtdClosedGCI: Math.round(mtdClosedGCI),
            ytdClosedGCI: Math.round(ytdClosedGCI),
            anomalyFlag: false,
        };
    }
    catch (err) {
        console.error("[Reporting] Business health error:", err);
        return {
            pipelineGCI: 0,
            mtdClosedVolume: 0,
            mtdClosedGCI: 0,
            ytdClosedGCI: 0,
            anomalyFlag: false,
        };
    }
}
