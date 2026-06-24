"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.repurposeSession = repurposeSession;
/**
 * Session repurpose — uses OpenShorts sidecar for clip generation.
 */
const crypto_1 = require("crypto");
const contentDb_js_1 = require("../../core/contentDb.js");
const experiments_js_1 = require("./brain/experiments.js");
const index_js_1 = require("../../integrations/openshorts/index.js");
async function callOpenShortsApi(sessionId, sourcePath, pillar = "brand") {
    if (!sourcePath) {
        throw new Error(`Session ${sessionId} has no source video path`);
    }
    const { jobId } = await (0, index_js_1.submitToOpenShorts)({
        filePath: sourcePath,
        pillar,
        trendBrief: "",
        targetClipCount: 7,
    });
    const result = await (0, index_js_1.pollOpenShortsJob)(jobId);
    if (!result.clips?.length) {
        throw new Error("OpenShorts returned no clips");
    }
    return result.clips;
}
async function repurposeSession(sessionId) {
    const session = (0, contentDb_js_1.getContentSession)(sessionId);
    if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.status === "complete" && session.clipsGenerated > 0) {
        console.log(`[content-manager/repurpose] session ${sessionId} already complete`);
    }
    const clipResults = await callOpenShortsApi(sessionId, session.rawInputPath, "brand");
    const created = [];
    for (const clip of clipResults) {
        const hook = (clip.hookPreview || clip.suggestedCaption.split(/[.!?]/)[0]) ?? clip.suggestedCaption;
        const video = (0, contentDb_js_1.insertContentVideo)({
            id: clip.clipId || (0, crypto_1.randomUUID)(),
            sourceSessionId: sessionId,
            platformTarget: "tiktok",
            title: clip.suggestedTitle || hook.slice(0, 60),
            caption: clip.suggestedCaption,
            hook,
            hashtags: [],
            pillar: clip.pillar || "brand",
            filePath: (0, index_js_1.mapClipUrlForFrontend)(clip.clipUrl || clip.clipPath),
            status: "pending_review",
            complianceFlagged: false,
            complianceNotes: null,
            approvedAt: null,
            scheduledFor: null,
            publishedAt: null,
            opusClipScore: clip.viralScore / 100,
            hookType: clip.hookType,
        });
        created.push(video);
        (0, experiments_js_1.assignVideoToExperiment)(video.id);
    }
    (0, contentDb_js_1.updateContentSession)(sessionId, {
        clipsGenerated: created.length,
        status: "complete",
        completedAt: new Date().toISOString(),
    });
    console.log(`[content-manager/repurpose] session ${sessionId} → ${created.length} clips`);
    return created;
}
