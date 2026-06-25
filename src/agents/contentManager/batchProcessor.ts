import { randomUUID } from "crypto";

import { contentManagerBrain } from "./brain/index.js";

import { enhanceClip } from "./clipEnhancer.js";

import {
  getCachedTrends,
  getTrendBriefForOpusClip,
  runCompetitorScrape,
} from "./competitorIntel.js";

import { runComplianceCheck } from "./compliance.js";

import {
  mapClipUrlForFrontend,
  pollOpenShortsJob,
  submitToOpenShorts,
  type OpenShortsClipResult,
} from "../../integrations/openshorts/index.js";

import {
  createContentSession,
  countClipsInApprovedOrScheduled,
  ensureDailyTargets,
  getBatchSession,
  listBatchSourceFiles,
  type CmBatchSession,
  type CmBatchSourceFile,
  type CmCompetitorTrends,
  insertContentVideo,
  todayDateCst,
  updateBatchSession,
  updateBatchSourceFile,
  updateContentSession,
  updateContentVideo,
  type ContentPillar,
} from "../../core/contentDb.js";

const POLL_INTERVAL_MS = 30_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveVideoPillar(batchPillar: string): ContentPillar {
  if (batchPillar === "education" || batchPillar === "listings" || batchPillar === "brand") {
    return batchPillar;
  }
  return "brand";
}

function fallbackTrendRecord(): CmCompetitorTrends {
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
    trendBrief:
      "Focus on specific San Antonio neighborhoods, mortgage rates, and first-time buyer education.",
    expiresAt: now,
  };
}

function calculateTargetClipsPerFile(fileCount: number): { total: number; perFile: number[] } {
  const today = todayDateCst();
  const targets = ensureDailyTargets(today);
  const pipelineCount = targets.videosPublished + countClipsInApprovedOrScheduled();
  let gap = Math.max(0, 7 - pipelineCount);
  const targetTotal = gap > 0 ? gap : 7;

  const perFile = Array(fileCount).fill(1);
  let remaining = targetTotal - fileCount;
  let idx = 0;
  while (remaining > 0) {
    perFile[idx % fileCount]++;
    remaining--;
    idx++;
  }
  return { total: targetTotal, perFile };
}

async function pollUntilComplete(jobId: string): Promise<OpenShortsClipResult[]> {
  const interval = jobId.startsWith("mock_") ? 100 : POLL_INTERVAL_MS;
  const start = Date.now();

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const result = await pollOpenShortsJob(jobId);
    if (
      (result.status === "complete" || result.status === "completed") &&
      result.clips?.length
    ) {
      return result.clips;
    }
    if (result.status === "failed") {
      throw new Error(`OpenShorts job failed: ${jobId}`);
    }
    await sleep(interval);
  }

  throw new Error(`OpenShorts job timed out: ${jobId}`);
}

async function processOpenShortsResults(
  sourceFile: CmBatchSourceFile,
  clips: OpenShortsClipResult[],
  batchSession: CmBatchSession,
  trendRecord: CmCompetitorTrends,
): Promise<{ created: number; enhanced: number; compliant: number }> {
  let created = 0;
  let enhanced = 0;
  let compliant = 0;
  const videoPillar = resolveVideoPillar(batchSession.pillar);

  for (const clip of clips) {
    try {
    const filePath = mapClipUrlForFrontend(clip.clipUrl || clip.clipPath);
    const thumbnailUrl = clip.thumbnailUrl ? mapClipUrlForFrontend(clip.thumbnailUrl) : null;
    const hookText =
      (clip.hookPreview || clip.suggestedCaption.split(/[.!?]/)[0]) ?? clip.suggestedCaption;
    const caption = clip.suggestedCaption;
    const title = clip.suggestedTitle || caption.slice(0, 60);
    const clipPillar = resolveVideoPillar(clip.pillar || batchSession.pillar);

    const session = createContentSession({
      rawInputType: "batch_clip",
      rawInputPath: sourceFile.filePath,
      rawInputMeta: {
        openShortsClipId: clip.clipId,
        startTime: clip.startTime,
        endTime: clip.endTime,
        thumbnailUrl,
      },
      batchSessionId: batchSession.id,
      filmedBy: batchSession.filmedBy,
    });

    const videoId = randomUUID();
    insertContentVideo({
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
      const enhancement = await enhanceClip({
        videoId,
        sourceFileId: sourceFile.id,
        clipResult: clip,
        pillar: batchSession.pillar,
        trendRecord,
        brain: contentManagerBrain,
      });
      enhanced++;

      updateContentVideo(videoId, {
        hook: enhancement.hookPrimary,
        caption: enhancement.captionFinal,
        hashtags: enhancement.hashtagsFinal,
        title: enhancement.titleFinal,
        hookType: enhancement.hookType,
        trendAlignmentScore: enhancement.trendAlignmentScore,
        platformTargets: enhancement.platformTargets,
        optimalPostTime: enhancement.optimalPostTimeTiktok,
        platformTarget:
          (enhancement.platformTargets[0] as "tiktok" | "instagram" | "facebook" | "youtube") ??
          "tiktok",
      });
    } catch (enhanceErr) {
      const msg = enhanceErr instanceof Error ? enhanceErr.message : String(enhanceErr);
      console.warn(`[batch-processor] Enhancement failed for clip ${videoId}: ${msg}`);
    }

    try {
      const complianceResult = await runComplianceCheck(videoId);
      if (complianceResult.passed) compliant++;
    } catch (compErr) {
      const msg = compErr instanceof Error ? compErr.message : String(compErr);
      console.warn(`[batch-processor] Compliance check failed for ${videoId}: ${msg}`);
    }

    updateContentVideo(videoId, { status: "pending_review", approvedAt: null });
    updateContentSession(session.id, {
      clipsGenerated: 1,
      status: "complete",
      completedAt: new Date().toISOString(),
    });

    const currentCount = sourceFile.clipsGeneratedCount + 1;
    updateBatchSourceFile(sourceFile.id, { clipsGeneratedCount: currentCount });
    sourceFile.clipsGeneratedCount = currentCount;

    created++;
    console.log(`[batch-processor] Clip ${videoId} created and ready for review`);
    } catch (clipErr) {
      const msg = clipErr instanceof Error ? clipErr.message : String(clipErr);
      console.error(`[batch-processor] Failed creating clip record: ${msg}`);
      if (clipErr instanceof Error && clipErr.stack) console.error(clipErr.stack);
      // Skip this clip — never let one clip failure kill the rest of the file's clips
    }
  }

  return { created, enhanced, compliant };
}

export async function processBatch(batchSessionId: string): Promise<void> {
  console.log(`[batch-processor] Starting batch ${batchSessionId}`);

  const batchSession = getBatchSession(batchSessionId);
  if (!batchSession) {
    console.error("[batch-processor] Batch not found:", batchSessionId);
    return;
  }

  const sourceFiles = listBatchSourceFiles(batchSessionId);
  if (sourceFiles.length === 0) {
    console.error("[batch-processor] No source files for batch:", batchSessionId);
    updateBatchSession(batchSessionId, { status: "failed" });
    return;
  }

  console.log(`[batch-processor] Found ${sourceFiles.length} source files`);

  let totalClips = 0;
  let totalEnhanced = 0;
  let totalCompliant = 0;

  try {
  updateBatchSession(batchSessionId, { status: "analyzing_trends" });

  let trendRecord: CmCompetitorTrends | null = null;
  try {
    trendRecord = getCachedTrends();
    if (!trendRecord) {
      console.log("[batch-processor] No cached trends — running competitor scrape");
      trendRecord = await runCompetitorScrape();
    }
    console.log(
      `[batch-processor] Trend data ready: ${trendRecord.trendBrief?.slice(0, 80) || "empty"}...`,
    );
  } catch (trendErr) {
    const msg = trendErr instanceof Error ? trendErr.message : String(trendErr);
    console.warn(`[batch-processor] Trend scrape failed (continuing without trends): ${msg}`);
    trendRecord = null;
  }

  const effectiveTrend = trendRecord ?? fallbackTrendRecord();
  if (trendRecord) {
    updateBatchSession(batchSessionId, { trendBriefId: trendRecord.id });
  }

  const { perFile } = calculateTargetClipsPerFile(sourceFiles.length);
  const trendBrief = trendRecord ? getTrendBriefForOpusClip(trendRecord) : effectiveTrend.trendBrief;
  console.log(
    `[batch-processor] Target clips per file: ${perFile.join(", ")} (total gap-driven)`,
  );

  updateBatchSession(batchSessionId, { status: "processing_opus" });

  for (const sourceFile of sourceFiles) {
    const fileIndex = sourceFiles.indexOf(sourceFile);
    const clipsForFile = perFile[fileIndex] ?? 1;

    try {
      console.log(`[batch-processor] Processing file: ${sourceFile.originalFilename}`);

      updateBatchSourceFile(sourceFile.id, {
        opusStatus: "submitted",
        opusSubmittedAt: new Date().toISOString(),
      });

      let jobId: string;
      try {
        const submission = await submitToOpenShorts({
          filePath: sourceFile.filePath,
          pillar: batchSession.pillar,
          trendBrief,
          targetClipCount: clipsForFile,
        });
        jobId = submission.jobId;
        console.log(
          `[batch-processor] OpenShorts job submitted: ${jobId} (status: ${submission.status})`,
        );
      } catch (submitErr) {
        const msg = submitErr instanceof Error ? submitErr.message : String(submitErr);
        console.error(`[batch-processor] OpenShorts submission failed: ${msg}. Using mock.`);
        jobId = `mock_${Date.now()}_${clipsForFile}`;
      }

      updateBatchSourceFile(sourceFile.id, { opusJobId: jobId, opusStatus: "processing" });
      updateBatchSession(batchSessionId, { status: "transcribing" });

      let openShortsClips: OpenShortsClipResult[];
      try {
        openShortsClips = await pollUntilComplete(jobId);
        console.log(
          `[batch-processor] Job ${jobId} complete: ${openShortsClips.length} clips`,
        );
      } catch (pollErr) {
        const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
        console.error(`[batch-processor] Polling failed for job ${jobId}: ${msg}`);
        updateBatchSourceFile(sourceFile.id, {
          opusStatus: "failed",
          errorMessage: msg,
        });
        continue;
      }

      if (!openShortsClips.length) {
        console.warn(`[batch-processor] Job ${jobId} returned no clips`);
        updateBatchSourceFile(sourceFile.id, { opusStatus: "failed", errorMessage: "No clips returned" });
        continue;
      }

      updateBatchSession(batchSessionId, { status: "analyzing" });
      await sleep(200);
      updateBatchSession(batchSessionId, { status: "reframing" });
      await sleep(200);

      updateBatchSession(batchSessionId, { status: "enhancing" });

      const result = await processOpenShortsResults(
        sourceFile,
        openShortsClips,
        batchSession,
        effectiveTrend,
      );

      totalClips += result.created;
      totalEnhanced += result.enhanced;
      totalCompliant += result.compliant;

      const fileStatus = result.created > 0 ? "complete" : "failed";
      updateBatchSourceFile(sourceFile.id, {
        opusStatus: fileStatus,
        opusCompletedAt: new Date().toISOString(),
        clipsGeneratedCount: result.created,
        errorMessage: result.created > 0 ? null : "No clip records could be created",
      });

      console.log(
        `[batch-processor] File ${sourceFile.originalFilename}: ${result.created}/${openShortsClips.length} clips saved`,
      );
    } catch (fileErr) {
      const msg = fileErr instanceof Error ? fileErr.message : String(fileErr);
      console.error(
        `[batch-processor] Failed processing file ${sourceFile.originalFilename}:`,
        msg,
      );
      updateBatchSourceFile(sourceFile.id, {
        opusStatus: "failed",
        errorMessage: msg,
      });
    }
  }

  const finalStatus = totalClips > 0 ? "complete" : "failed";
  updateBatchSession(batchSessionId, {
    status: finalStatus,
    completedAt: new Date().toISOString(),
    clipsGenerated: totalClips,
  });

  console.log(
    `[batch-processor] Batch ${batchSessionId} finished with status '${finalStatus}' — ${totalClips} clips generated from ${sourceFiles.length} videos, ${totalEnhanced} enhanced, ${totalCompliant} passed compliance.`,
  );
  } catch (fatalErr) {
    // Only a truly fatal error reaches here — individual file/clip failures are
    // handled and skipped inside the loop. Fail the batch only if no clips were created.
    const msg = fatalErr instanceof Error ? fatalErr.message : String(fatalErr);
    console.error(`[batch-processor] FATAL error in batch ${batchSessionId}: ${msg}`);
    if (fatalErr instanceof Error && fatalErr.stack) console.error(fatalErr.stack);
    const recoveredStatus = totalClips > 0 ? "complete" : "failed";
    updateBatchSession(batchSessionId, {
      status: recoveredStatus,
      completedAt: new Date().toISOString(),
      clipsGenerated: totalClips,
    });
    console.log(
      `[batch-processor] Batch ${batchSessionId} recovered to '${recoveredStatus}' after fatal error — ${totalClips} clips salvaged`,
    );
  }
}
