/**
 * Session repurpose — uses OpenShorts sidecar for clip generation.
 */
import { randomUUID } from "crypto";
import {
  getContentSession,
  insertContentVideo,
  updateContentSession,
  type ContentPillar,
  type ContentVideo,
} from "../../core/contentDb.js";
import { assignVideoToExperiment } from "./brain/experiments.js";
import {
  mapClipUrlForFrontend,
  pollOpenShortsJob,
  submitToOpenShorts,
  type OpenShortsClipResult,
} from "../../integrations/openshorts/index.js";

async function callOpenShortsApi(
  sessionId: string,
  sourcePath: string | null,
  pillar: ContentPillar = "brand",
): Promise<OpenShortsClipResult[]> {
  if (!sourcePath) {
    throw new Error(`Session ${sessionId} has no source video path`);
  }

  const { jobId } = await submitToOpenShorts({
    filePath: sourcePath,
    pillar,
    trendBrief: "",
    targetClipCount: 7,
  });

  const result = await pollOpenShortsJob(jobId);
  if (!result.clips?.length) {
    throw new Error("OpenShorts returned no clips");
  }
  return result.clips;
}

export async function repurposeSession(sessionId: string): Promise<ContentVideo[]> {
  const session = getContentSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (session.status === "complete" && session.clipsGenerated > 0) {
    console.log(`[content-manager/repurpose] session ${sessionId} already complete`);
  }

  const clipResults = await callOpenShortsApi(sessionId, session.rawInputPath, "brand");
  const created: ContentVideo[] = [];

  for (const clip of clipResults) {
    const hook =
      (clip.hookPreview || clip.suggestedCaption.split(/[.!?]/)[0]) ?? clip.suggestedCaption;
    const video = insertContentVideo({
      id: clip.clipId || randomUUID(),
      sourceSessionId: sessionId,
      platformTarget: "tiktok",
      title: clip.suggestedTitle || hook.slice(0, 60),
      caption: clip.suggestedCaption,
      hook,
      hashtags: [],
      pillar: (clip.pillar as ContentPillar) || "brand",
      filePath: mapClipUrlForFrontend(clip.clipUrl || clip.clipPath),
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
    assignVideoToExperiment(video.id);
  }

  updateContentSession(sessionId, {
    clipsGenerated: created.length,
    status: "complete",
    completedAt: new Date().toISOString(),
  });

  console.log(`[content-manager/repurpose] session ${sessionId} → ${created.length} clips`);
  return created;
}
