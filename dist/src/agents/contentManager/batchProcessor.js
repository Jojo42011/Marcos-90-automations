"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processBatch = processBatch;
const crypto_1 = require("crypto");
const index_js_1 = require("./brain/index.js");
const clipEnhancer_js_1 = require("./clipEnhancer.js");
const competitorIntel_js_1 = require("./competitorIntel.js");
const compliance_js_1 = require("./compliance.js");
const index_js_2 = require("../../integrations/openshorts/index.js");
const diskCleanup_js_1 = require("../../core/diskCleanup.js");
const MIN_FREE_DISK_MB = 600;
const contentDb_js_1 = require("../../core/contentDb.js");
const POLL_INTERVAL_MS = 30_000;
const POLL_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours — matches sidecar job budget
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function resolveVideoPillar(batchPillar) {
    if (batchPillar === "education" || batchPillar === "listings" || batchPillar === "brand") {
        return batchPillar;
    }
    return "brand";
}
function fallbackTrendRecord() {
    const now = new Date().toISOString();
    return {
        id: "fallback",
        scrapedAt: now,
        profilesScraped: [],
        rawVideoCount: 0,
        topHooks: [],
        trendingHashtags: ["sanantonio", "sanantoniohomes", "firsttimehomebuyer"],
        topPerformingDurations: {},
        bestDurationRange: "30_to_60",
        topContentThemes: [],
        trendBrief: "Focus on specific San Antonio neighborhoods, mortgage rates, and first-time buyer education.",
        expiresAt: now,
    };
}
// Phase 4 — quality over volume. Each per-file number here is a MAXIMUM handed to
// the engine, not a quota: the sidecar's viral-score gate returns fewer, stronger
// clips when a source only has a couple of great moments (it never pads). We also
// cap any single source at MAX_CLIPS_PER_SOURCE so a low day's gap can't demand 7
// clips out of one recording. The daily 7 stays a raw-recording goal, not a
// per-video publish quota.
const MAX_CLIPS_PER_SOURCE = Math.max(1, Number(process.env.MAX_CLIPS_PER_SOURCE) || 5);
function calculateTargetClipsPerFile(fileCount) {
    const today = (0, contentDb_js_1.todayDateCst)();
    const targets = (0, contentDb_js_1.ensureDailyTargets)(today);
    const pipelineCount = targets.videosPublished + (0, contentDb_js_1.countClipsInApprovedOrScheduled)();
    const gap = Math.max(0, 7 - pipelineCount);
    const targetTotal = gap > 0 ? gap : 7;
    const perFile = Array(fileCount).fill(1);
    let remaining = targetTotal - fileCount;
    let idx = 0;
    // Distribute the day's remaining budget across sources, but never ask any one
    // source for more than MAX_CLIPS_PER_SOURCE — better to leave the gap for the
    // next recording than to squeeze filler clips out of a single video.
    while (remaining > 0) {
        const target = idx % fileCount;
        if (perFile[target] < MAX_CLIPS_PER_SOURCE) {
            perFile[target]++;
            remaining--;
        }
        else if (perFile.every((n) => n >= MAX_CLIPS_PER_SOURCE)) {
            break; // every source is already at its cap
        }
        idx++;
    }
    return { total: targetTotal, perFile };
}
async function pollUntilComplete(jobId) {
    const interval = jobId.startsWith("mock_") ? 100 : POLL_INTERVAL_MS;
    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT_MS) {
        const result = await (0, index_js_2.pollOpenShortsJob)(jobId);
        if ((result.status === "complete" || result.status === "completed") &&
            result.clips?.length) {
            return result.clips;
        }
        if (result.status === "failed") {
            throw new Error(`OpenShorts job failed: ${jobId}`);
        }
        await sleep(interval);
    }
    throw new Error(`OpenShorts job timed out: ${jobId}`);
}
async function processOpenShortsResults(sourceFile, clips, batchSession, trendRecord) {
    let created = 0;
    let enhanced = 0;
    let compliant = 0;
    const videoPillar = resolveVideoPillar(batchSession.pillar);
    for (const clip of clips) {
        try {
            const filePath = clip.clipPath?.startsWith("mock://")
                ? clip.clipPath
                : clip.clipPath || (0, index_js_2.mapClipUrlForFrontend)(clip.clipUrl || "");
            const thumbnailUrl = clip.thumbnailUrl ? (0, index_js_2.mapClipUrlForFrontend)(clip.thumbnailUrl) : null;
            const hookText = (clip.hookPreview || clip.suggestedCaption.split(/[.!?]/)[0]) ?? clip.suggestedCaption;
            const caption = clip.suggestedCaption;
            const title = clip.suggestedTitle || caption.slice(0, 60);
            const clipPillar = resolveVideoPillar(clip.pillar || batchSession.pillar);
            const session = (0, contentDb_js_1.createContentSession)({
                rawInputType: "batch_clip",
                rawInputPath: sourceFile.filePath,
                rawInputMeta: {
                    openShortsClipId: clip.clipId,
                    clipPath: clip.clipPath || null,
                    clipUrl: clip.clipUrl || null,
                    startTime: clip.startTime,
                    endTime: clip.endTime,
                    thumbnailUrl,
                },
                batchSessionId: batchSession.id,
                filmedBy: batchSession.filmedBy,
            });
            const videoId = (0, crypto_1.randomUUID)();
            (0, contentDb_js_1.insertContentVideo)({
                id: videoId,
                sourceSessionId: session.id,
                platformTarget: "tiktok",
                title,
                caption,
                hook: hookText,
                hashtags: [],
                pillar: clipPillar || videoPillar,
                filePath,
                status: "processing",
                complianceFlagged: false,
                complianceNotes: null,
                approvedAt: null,
                scheduledFor: null,
                publishedAt: null,
                batchSessionId: batchSession.id,
                sourceFileId: sourceFile.id,
                opusClipScore: clip.viralScore / 100,
                hookType: clip.hookType,
            });
            try {
                const enhancement = await (0, clipEnhancer_js_1.enhanceClip)({
                    videoId,
                    sourceFileId: sourceFile.id,
                    clipResult: clip,
                    pillar: batchSession.pillar,
                    trendRecord,
                    brain: index_js_1.contentManagerBrain,
                });
                enhanced++;
                (0, contentDb_js_1.updateContentVideo)(videoId, {
                    hook: enhancement.hookPrimary,
                    caption: enhancement.captionFinal,
                    hashtags: enhancement.hashtagsFinal,
                    title: enhancement.titleFinal,
                    hookType: enhancement.hookType,
                    trendAlignmentScore: enhancement.trendAlignmentScore,
                    platformTargets: enhancement.platformTargets,
                    optimalPostTime: enhancement.optimalPostTimeTiktok,
                    platformTarget: enhancement.platformTargets[0] ??
                        "tiktok",
                });
            }
            catch (enhanceErr) {
                const msg = enhanceErr instanceof Error ? enhanceErr.message : String(enhanceErr);
                console.warn(`[batch-processor] Enhancement failed for clip ${videoId}: ${msg}`);
            }
            try {
                const complianceResult = await (0, compliance_js_1.runComplianceCheck)(videoId);
                if (complianceResult.passed)
                    compliant++;
            }
            catch (compErr) {
                const msg = compErr instanceof Error ? compErr.message : String(compErr);
                console.warn(`[batch-processor] Compliance check failed for ${videoId}: ${msg}`);
            }
            (0, contentDb_js_1.updateContentVideo)(videoId, { status: "pending_review", approvedAt: null });
            (0, contentDb_js_1.updateContentSession)(session.id, {
                clipsGenerated: 1,
                status: "complete",
                completedAt: new Date().toISOString(),
            });
            const currentCount = sourceFile.clipsGeneratedCount + 1;
            (0, contentDb_js_1.updateBatchSourceFile)(sourceFile.id, { clipsGeneratedCount: currentCount });
            sourceFile.clipsGeneratedCount = currentCount;
            created++;
            console.log(`[batch-processor] Clip ${videoId} created and ready for review`);
        }
        catch (clipErr) {
            const msg = clipErr instanceof Error ? clipErr.message : String(clipErr);
            console.error(`[batch-processor] Failed creating clip record: ${msg}`);
            if (clipErr instanceof Error && clipErr.stack)
                console.error(clipErr.stack);
            // Skip this clip — never let one clip failure kill the rest of the file's clips
        }
    }
    return { created, enhanced, compliant };
}
async function processBatch(batchSessionId) {
    console.log(`[batch-processor] Starting batch ${batchSessionId}`);
    const batchSession = (0, contentDb_js_1.getBatchSession)(batchSessionId);
    if (!batchSession) {
        console.error("[batch-processor] Batch not found:", batchSessionId);
        return;
    }
    const sourceFiles = (0, contentDb_js_1.listBatchSourceFiles)(batchSessionId);
    if (sourceFiles.length === 0) {
        console.error("[batch-processor] No source files for batch:", batchSessionId);
        (0, contentDb_js_1.updateBatchSession)(batchSessionId, { status: "failed" });
        return;
    }
    console.log(`[batch-processor] Found ${sourceFiles.length} source files`);
    let totalClips = 0;
    let totalEnhanced = 0;
    let totalCompliant = 0;
    try {
        (0, contentDb_js_1.updateBatchSession)(batchSessionId, { status: "analyzing_trends" });
        let trendRecord = null;
        try {
            trendRecord = (0, competitorIntel_js_1.getCachedTrends)();
            if (!trendRecord) {
                console.log("[batch-processor] No cached trends — running competitor scrape");
                trendRecord = await (0, competitorIntel_js_1.runCompetitorScrape)();
            }
            console.log(`[batch-processor] Trend data ready: ${trendRecord.trendBrief?.slice(0, 80) || "empty"}...`);
        }
        catch (trendErr) {
            const msg = trendErr instanceof Error ? trendErr.message : String(trendErr);
            console.warn(`[batch-processor] Trend scrape failed (continuing without trends): ${msg}`);
            trendRecord = null;
        }
        const effectiveTrend = trendRecord ?? fallbackTrendRecord();
        if (trendRecord) {
            (0, contentDb_js_1.updateBatchSession)(batchSessionId, { trendBriefId: trendRecord.id });
        }
        const { perFile } = calculateTargetClipsPerFile(sourceFiles.length);
        const trendBrief = trendRecord ? (0, competitorIntel_js_1.getTrendBriefForOpusClip)(trendRecord) : effectiveTrend.trendBrief;
        console.log(`[batch-processor] Max clips per file: ${perFile.join(", ")} ` +
            `(gap-driven ceiling, capped at ${MAX_CLIPS_PER_SOURCE}/source; the engine quality-gates below this)`);
        (0, contentDb_js_1.updateBatchSession)(batchSessionId, { status: "processing_opus" });
        for (const sourceFile of sourceFiles) {
            const fileIndex = sourceFiles.indexOf(sourceFile);
            const clipsForFile = perFile[fileIndex] ?? 1;
            try {
                console.log(`[batch-processor] Processing file: ${sourceFile.originalFilename}`);
                // Fix 4 — fail fast on low disk instead of submitting and timing out ~8s later.
                const freeMB = await (0, diskCleanup_js_1.getFreeDiskMB)();
                if (Number.isFinite(freeMB) && freeMB < MIN_FREE_DISK_MB) {
                    const msg = `Not enough disk space to process — ${freeMB}MB available, ${MIN_FREE_DISK_MB}MB required. ` +
                        `Free up space by reviewing and publishing pending clips, or contact support.`;
                    console.warn(`[batch-processor] Disk space check failed: ${freeMB}MB available, ${MIN_FREE_DISK_MB}MB required. Job not submitted.`);
                    (0, contentDb_js_1.updateBatchSourceFile)(sourceFile.id, { opusStatus: "failed", errorMessage: msg });
                    continue;
                }
                (0, contentDb_js_1.updateBatchSourceFile)(sourceFile.id, {
                    opusStatus: "submitted",
                    opusSubmittedAt: new Date().toISOString(),
                });
                let jobId;
                try {
                    const submission = await (0, index_js_2.submitToOpenShorts)({
                        filePath: sourceFile.filePath,
                        pillar: batchSession.pillar,
                        trendBrief,
                        targetClipCount: clipsForFile,
                        userContext: batchSession.userContext || "",
                        scriptText: batchSession.scriptText || "",
                    });
                    jobId = submission.jobId;
                    console.log(`[batch-processor] OpenShorts job submitted: ${jobId} (status: ${submission.status})`);
                }
                catch (submitErr) {
                    const msg = submitErr instanceof Error ? submitErr.message : String(submitErr);
                    // Sidecar offline = a clear, actionable error. Rethrow so user sees it immediately.
                    if (msg.includes("sidecar is not running") || msg.includes("npm run sidecar:start")) {
                        throw new Error(`[batch-processor] ${msg}`);
                    }
                    // Other submission errors: log and skip this file
                    console.error(`[batch-processor] OpenShorts submission failed: ${msg}`);
                    (0, contentDb_js_1.updateBatchSourceFile)(sourceFile.id, {
                        opusStatus: "failed",
                        errorMessage: msg,
                    });
                    continue;
                }
                (0, contentDb_js_1.updateBatchSourceFile)(sourceFile.id, { opusJobId: jobId, opusStatus: "processing" });
                (0, contentDb_js_1.updateBatchSession)(batchSessionId, { status: "transcribing" });
                let openShortsClips;
                try {
                    openShortsClips = await pollUntilComplete(jobId);
                    console.log(`[batch-processor] Job ${jobId} complete: ${openShortsClips.length} clips`);
                }
                catch (pollErr) {
                    const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
                    console.error(`[batch-processor] Polling failed for job ${jobId}: ${msg}`);
                    (0, contentDb_js_1.updateBatchSourceFile)(sourceFile.id, {
                        opusStatus: "failed",
                        errorMessage: msg,
                    });
                    continue;
                }
                if (!openShortsClips.length) {
                    console.warn(`[batch-processor] Job ${jobId} returned no clips`);
                    (0, contentDb_js_1.updateBatchSourceFile)(sourceFile.id, { opusStatus: "failed", errorMessage: "No clips returned" });
                    continue;
                }
                (0, contentDb_js_1.updateBatchSession)(batchSessionId, { status: "analyzing" });
                await sleep(200);
                (0, contentDb_js_1.updateBatchSession)(batchSessionId, { status: "reframing" });
                await sleep(200);
                (0, contentDb_js_1.updateBatchSession)(batchSessionId, { status: "enhancing" });
                const result = await processOpenShortsResults(sourceFile, openShortsClips, batchSession, effectiveTrend);
                totalClips += result.created;
                totalEnhanced += result.enhanced;
                totalCompliant += result.compliant;
                const fileStatus = result.created > 0 ? "complete" : "failed";
                (0, contentDb_js_1.updateBatchSourceFile)(sourceFile.id, {
                    opusStatus: fileStatus,
                    opusCompletedAt: new Date().toISOString(),
                    clipsGeneratedCount: result.created,
                    errorMessage: result.created > 0 ? null : "No clip records could be created",
                });
                console.log(`[batch-processor] File ${sourceFile.originalFilename}: ${result.created}/${openShortsClips.length} clips saved`);
                // Fix 1 — source file is no longer needed once its clips are created.
                // Only on success; a failed file is kept so the user can retry.
                if (fileStatus === "complete") {
                    (0, diskCleanup_js_1.deleteSourceFile)(sourceFile.filePath);
                }
            }
            catch (fileErr) {
                const msg = fileErr instanceof Error ? fileErr.message : String(fileErr);
                console.error(`[batch-processor] Failed processing file ${sourceFile.originalFilename}:`, msg);
                (0, contentDb_js_1.updateBatchSourceFile)(sourceFile.id, {
                    opusStatus: "failed",
                    errorMessage: msg,
                });
            }
        }
        const finalStatus = totalClips > 0 ? "complete" : "failed";
        (0, contentDb_js_1.updateBatchSession)(batchSessionId, {
            status: finalStatus,
            completedAt: new Date().toISOString(),
            clipsGenerated: totalClips,
        });
        console.log(`[batch-processor] Batch ${batchSessionId} finished with status '${finalStatus}' — ${totalClips} clips generated from ${sourceFiles.length} videos, ${totalEnhanced} enhanced, ${totalCompliant} passed compliance.`);
    }
    catch (fatalErr) {
        // Only a truly fatal error reaches here — individual file/clip failures are
        // handled and skipped inside the loop. Fail the batch only if no clips were created.
        const msg = fatalErr instanceof Error ? fatalErr.message : String(fatalErr);
        console.error(`[batch-processor] FATAL error in batch ${batchSessionId}: ${msg}`);
        if (fatalErr instanceof Error && fatalErr.stack)
            console.error(fatalErr.stack);
        const recoveredStatus = totalClips > 0 ? "complete" : "failed";
        (0, contentDb_js_1.updateBatchSession)(batchSessionId, {
            status: recoveredStatus,
            completedAt: new Date().toISOString(),
            clipsGenerated: totalClips,
        });
        console.log(`[batch-processor] Batch ${batchSessionId} recovered to '${recoveredStatus}' after fatal error — ${totalClips} clips salvaged`);
    }
}
