"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildOpusClipPrompt = buildOpusClipPrompt;
exports.generateMockClips = generateMockClips;
exports.submitToOpusClip = submitToOpusClip;
exports.pollOpusClipJob = pollOpusClipJob;
const crypto_1 = require("crypto");
const mockJobClipCounts = new Map();
const mockJobPolled = new Set();
const REAL_ESTATE_CAPTIONS = [
    "San Antonio buyers — this number changes everything about your monthly payment.",
    "Nobody talks about this when you're buying your first home in Texas.",
    "I just walked this Stone Oak listing and the price surprised even me.",
    "Here's what $400K actually gets you in San Antonio right now.",
    "If you're waiting for rates to drop, watch this first.",
    "This is the mistake I see first-time buyers make every week.",
    "Canyon Lake is blowing up — here's what agents aren't telling you.",
    "Just listed: the kitchen alone sold this house in my mind.",
];
const REAL_ESTATE_HASHTAGS = [
    "sanantonio",
    "sanantoniohomes",
    "texasrealestate",
    "firsttimehomebuyer",
    "realestate",
    "homebuyingtips",
    "sanantoniotx",
    "newhome",
];
function randomBetween(min, max) {
    return min + Math.random() * (max - min);
}
function buildOpusClipPrompt(pillar, trendBrief, targetClipCount, sessionName) {
    const pillarInstructions = {
        education: "Prioritize moments where Marco explains a specific number, process step, or market insight clearly.",
        listings: "Prioritize moments showcasing the best property features, neighborhood context, or price insight.",
        brand: "Prioritize moments where Marco is confident, direct, and speaking from personal experience or a recent win.",
        mixed: "Prioritize the most engaging mix of education, listing highlights, and personal brand moments.",
    };
    const pillarLine = pillarInstructions[pillar] ?? pillarInstructions.mixed;
    const sessionLine = sessionName ? `Session: ${sessionName}. ` : "";
    return (`This is a batch filming session for @puga.realtor, a real estate agent in San Antonio, Texas. ` +
        `Find the ${targetClipCount} most engaging moments from this footage. ${sessionLine}` +
        `${pillarLine} ${trendBrief} ` +
        "Each clip should be 30-60 seconds optimized for TikTok vertical format. " +
        "Prioritize moments with high energy, clear audio, and a natural hook in the first 3 seconds.");
}
function generateMockClips(count) {
    const clips = [];
    for (let i = 0; i < count; i++) {
        const clipId = (0, crypto_1.randomUUID)();
        const startTime = Math.floor(randomBetween(0, 600));
        const duration = Math.floor(randomBetween(35, 60));
        const endTime = startTime + duration;
        const caption = REAL_ESTATE_CAPTIONS[i % REAL_ESTATE_CAPTIONS.length];
        const hashtags = REAL_ESTATE_HASHTAGS.slice(0, 3 + (i % 3));
        clips.push({
            clipId,
            videoUrl: `mock://clip/${clipId}`,
            thumbnailUrl: `mock://thumbnail/${clipId}`,
            startTime,
            endTime,
            duration,
            opusScore: randomBetween(0.6, 0.95),
            suggestedCaption: caption,
            suggestedHashtags: hashtags,
        });
    }
    return clips;
}
async function submitToOpusClip(input) {
    // OPUS_CLIP_API — wire when OPUSCLIP_API_KEY env var is available
    // OpusClip API docs: https://www.opus.pro/api
    // POST /api/v1/clips with multipart/form-data: video file + prompt + num_clips + min_duration=25 + max_duration=65 + target_platform=tiktok
    // Returns: { job_id: string, status: "processing" }
    const apiKey = process.env.OPUSCLIP_API_KEY?.trim();
    if (apiKey) {
        // Real API integration placeholder — falls through to stub until wired
        console.log("[opusclip] OPUSCLIP_API_KEY set but API not yet wired — using stub");
    }
    const jobId = `mock_${input.targetClipCount}_${(0, crypto_1.randomUUID)()}`;
    mockJobClipCounts.set(jobId, input.targetClipCount);
    mockJobPolled.delete(jobId);
    return { jobId, status: "processing" };
}
async function pollOpusClipJob(jobId) {
    // OPUS_CLIP_API — wire when key is available
    // GET /api/v1/clips/{jobId}
    if (jobId.startsWith("mock_")) {
        if (!mockJobPolled.has(jobId)) {
            mockJobPolled.add(jobId);
            return { status: "processing" };
        }
        const count = mockJobClipCounts.get(jobId) ?? 2;
        return { status: "completed", clips: generateMockClips(count) };
    }
    return { status: "failed" };
}
