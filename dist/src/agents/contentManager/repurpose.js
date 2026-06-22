"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.repurposeSession = repurposeSession;
/**
 * OpusClip API docs at https://www.opus.pro/api — requires API key.
 * Wire OPUSCLIP_API_KEY env var when available.
 * The call will be a POST with the source video file, target duration range, and number of clips requested.
 */
const crypto_1 = require("crypto");
const contentDb_js_1 = require("../../core/contentDb.js");
const experiments_js_1 = require("./brain/experiments.js");
const MOCK_HOOKS = [
    "San Antonio buyers — here's what nobody tells you about new construction.",
    "This listing just hit the market and it's moving fast.",
    "Rates dropped — here's what that means for your payment.",
    "POV: you're touring a $600K home west of Stone Oak.",
    "Marco breaks down the real numbers on this deal.",
    "If you're still renting in SA, watch this.",
    "The Canyon Lake market in 60 seconds.",
];
const MOCK_HASHTAGS = [
    ["#sanantonio", "#realestate", "#newconstruction"],
    ["#sanantoniohomes", "#realtor", "#texasrealestate"],
    ["#firsttimehomebuyer", "#mortgagerates", "#sanantonio"],
    ["#hometour", "#luxuryhomes", "#stoneoak"],
    ["#realestateagent", "#buyersagent", "#satx"],
    ["#canyonlake", "#lakehouse", "#texas"],
    ["#marcoonthemarket", "#realestateinvesting", "#sanantonio"],
];
async function callOpusClipApi(sessionId, _sourcePath) {
    // OPUS_CLIP_API — wire when API key is available
    // const apiKey = process.env.OPUSCLIP_API_KEY?.trim();
    // if (!apiKey) throw new Error("OPUSCLIP_API_KEY not set");
    // POST to OpusClip with source video, duration range, clip count = 7
    const clips = [];
    for (let i = 0; i < 7; i++) {
        const clipId = `opus_stub_${(0, crypto_1.randomUUID)().slice(0, 8)}_${i + 1}`;
        clips.push({
            id: clipId,
            title: `Clip ${i + 1} — Session ${sessionId.slice(0, 8)}`,
            suggested_caption: `${MOCK_HOOKS[i]} Full breakdown in comments — DM me for the spec sheet.`,
            suggested_hook: MOCK_HOOKS[i],
            suggested_hashtags: MOCK_HASHTAGS[i],
            pillar: i < 2 ? "listings" : i < 5 ? "education" : "brand",
            file_path: `/data/content/clips/${clipId}.mp4`,
        });
    }
    return clips;
}
async function repurposeSession(sessionId) {
    const session = (0, contentDb_js_1.getContentSession)(sessionId);
    if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.status === "complete" && session.clipsGenerated > 0) {
        console.log(`[content-manager/repurpose] session ${sessionId} already complete`);
    }
    const clipResults = await callOpusClipApi(sessionId, session.rawInputPath);
    const created = [];
    for (const clip of clipResults) {
        const video = (0, contentDb_js_1.insertContentVideo)({
            id: clip.id,
            sourceSessionId: sessionId,
            platformTarget: "tiktok",
            title: clip.title,
            caption: clip.suggested_caption,
            hook: clip.suggested_hook,
            hashtags: clip.suggested_hashtags,
            pillar: clip.pillar,
            filePath: clip.file_path,
            status: "pending_review",
            complianceFlagged: false,
            complianceNotes: null,
            approvedAt: null,
            scheduledFor: null,
            publishedAt: null,
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
