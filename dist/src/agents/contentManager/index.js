"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWeeklyReport = exports.getDailyReport = exports.runPerformanceSync = exports.trackDmTriaged = exports.trackCommentManaged = exports.triageDm = exports.publishVideo = exports.applyComplianceDecision = exports.runComplianceCheck = exports.repurposeSession = exports.ingestContent = void 0;
exports.runContentManagerJob = runContentManagerJob;
exports.scheduleContentManagerDaily7pmCST = scheduleContentManagerDaily7pmCST;
const contentDb_js_1 = require("../../core/contentDb.js");
const analytics_js_1 = require("./analytics.js");
var ingest_js_1 = require("./ingest.js");
Object.defineProperty(exports, "ingestContent", { enumerable: true, get: function () { return ingest_js_1.ingestContent; } });
var repurpose_js_1 = require("./repurpose.js");
Object.defineProperty(exports, "repurposeSession", { enumerable: true, get: function () { return repurpose_js_1.repurposeSession; } });
var compliance_js_1 = require("./compliance.js");
Object.defineProperty(exports, "runComplianceCheck", { enumerable: true, get: function () { return compliance_js_1.runComplianceCheck; } });
Object.defineProperty(exports, "applyComplianceDecision", { enumerable: true, get: function () { return compliance_js_1.applyComplianceDecision; } });
var publish_js_1 = require("./publish.js");
Object.defineProperty(exports, "publishVideo", { enumerable: true, get: function () { return publish_js_1.publishVideo; } });
var communityManager_js_1 = require("./communityManager.js");
Object.defineProperty(exports, "triageDm", { enumerable: true, get: function () { return communityManager_js_1.triageDm; } });
Object.defineProperty(exports, "trackCommentManaged", { enumerable: true, get: function () { return communityManager_js_1.trackCommentManaged; } });
Object.defineProperty(exports, "trackDmTriaged", { enumerable: true, get: function () { return communityManager_js_1.trackDmTriaged; } });
var analytics_js_2 = require("./analytics.js");
Object.defineProperty(exports, "runPerformanceSync", { enumerable: true, get: function () { return analytics_js_2.runPerformanceSync; } });
Object.defineProperty(exports, "getDailyReport", { enumerable: true, get: function () { return analytics_js_2.getDailyReport; } });
Object.defineProperty(exports, "getWeeklyReport", { enumerable: true, get: function () { return analytics_js_2.getWeeklyReport; } });
let lastScheduledContentManagerDate = null;
/** Main scheduled entry point — daily 7pm CST. */
async function runContentManagerJob() {
    const syncSummary = await (0, analytics_js_1.runPerformanceSync)();
    const today = (0, contentDb_js_1.todayDateCst)();
    (0, contentDb_js_1.ensureDailyTargets)(today);
    const dailyReport = (0, analytics_js_1.getDailyReport)(today);
    const t = dailyReport.targets;
    console.log(`[content-manager] Daily sync complete — ${t.videosPublished}/${t.videosTarget} videos, ` +
        `${t.phoneNumbersCaptured}/${t.phoneNumbersTarget} numbers, ` +
        `${syncSummary.hotCount}/${syncSummary.averageCount}/${syncSummary.coldCount} performance split`);
    return {
        syncSummary,
        dailyReport,
        weeklyReport: (0, analytics_js_1.getWeeklyReport)(),
    };
}
/** Run runContentManagerJob once per day at 7:00 PM America/Chicago. */
function scheduleContentManagerDaily7pmCST() {
    console.log("[content-manager] daily job scheduled at 7:00 PM America/Chicago");
    setInterval(() => {
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
        if (hour === 19 && minute >= 0 && minute < 2 && lastScheduledContentManagerDate !== dateStr) {
            lastScheduledContentManagerDate = dateStr;
            runContentManagerJob().catch((err) => console.error("[content-manager] scheduled run failed:", err));
        }
    }, 60_000);
}
