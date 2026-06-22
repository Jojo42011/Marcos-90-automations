import Anthropic from "@anthropic-ai/sdk";
import {
  getContentVideo,
  insertComplianceQueueItem,
  updateComplianceQueueDecision,
  updateContentVideo,
} from "../../core/contentDb.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const COMPLIANCE_SYSTEM_PROMPT = `You are a real estate content compliance checker. Review the following social media content for: (1) Fair Housing Act violations — never mention race, religion, national origin, sex, disability, familial status, or neighborhood demographics. (2) MLS rules — never publish an address, MLS listing ID, or broker attribution without approval. (3) Brand voice — content must be direct, first-person, conversational, no corporate buzzwords. Return JSON only: { "passed": boolean, "flags": string[], "brand_issues": string[], "recommendation": string }`;

export interface ComplianceCheckResult {
  passed: boolean;
  flags: string[];
  brand_issues: string[];
  recommendation: string;
}

function parseComplianceJson(text: string): ComplianceCheckResult {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      passed: false,
      flags: ["Unable to parse compliance response"],
      brand_issues: [],
      recommendation: "Re-run compliance check or review manually.",
    };
  }
  try {
    const parsed = JSON.parse(match[0]) as ComplianceCheckResult;
    return {
      passed: Boolean(parsed.passed),
      flags: Array.isArray(parsed.flags) ? parsed.flags.map(String) : [],
      brand_issues: Array.isArray(parsed.brand_issues) ? parsed.brand_issues.map(String) : [],
      recommendation: String(parsed.recommendation ?? ""),
    };
  } catch {
    return {
      passed: false,
      flags: ["Invalid JSON from compliance model"],
      brand_issues: [],
      recommendation: "Review manually.",
    };
  }
}

export async function runComplianceCheck(videoId: string): Promise<ComplianceCheckResult> {
  const video = getContentVideo(videoId);
  if (!video) {
    throw new Error(`Video not found: ${videoId}`);
  }

  const contentBlock = [
    `Caption: ${video.caption}`,
    `Hook: ${video.hook}`,
    `Hashtags: ${video.hashtags.join(" ")}`,
    `Pillar: ${video.pillar}`,
  ].join("\n");

  let result: ComplianceCheckResult = {
    passed: true,
    flags: [],
    brand_issues: [],
    recommendation: "Auto-approved (compliance offline).",
  };

  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: COMPLIANCE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: contentBlock }],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    result = parseComplianceJson(text);
  }

  if (result.passed) {
    updateContentVideo(videoId, {
      status: "approved",
      complianceFlagged: false,
      complianceNotes: result.recommendation || null,
      approvedAt: new Date().toISOString(),
    });
  } else {
    const flagsText = [...result.flags, ...result.brand_issues].join("; ");
    updateContentVideo(videoId, {
      status: "pending_review",
      complianceFlagged: true,
      complianceNotes: flagsText || result.recommendation,
    });
    insertComplianceQueueItem({
      videoId,
      flaggedReason: flagsText || result.recommendation || "Compliance flags raised",
    });
  }

  console.log(`[content-manager/compliance] video ${videoId} passed=${result.passed}`);
  return result;
}

export function applyComplianceDecision(
  videoId: string,
  decision: "approved" | "rejected",
  reason?: string,
): { videoId: string; status: string } {
  const video = getContentVideo(videoId);
  if (!video) throw new Error(`Video not found: ${videoId}`);

  if (decision === "approved") {
    updateContentVideo(videoId, {
      status: "approved",
      complianceFlagged: false,
      complianceNotes: reason || video.complianceNotes,
      approvedAt: new Date().toISOString(),
    });
    updateComplianceQueueDecision(videoId, "approved");
  } else {
    updateContentVideo(videoId, {
      status: "rejected",
      complianceFlagged: true,
      complianceNotes: reason || "Rejected by reviewer",
    });
    updateComplianceQueueDecision(videoId, "rejected");
  }

  return { videoId, status: decision === "approved" ? "approved" : "rejected" };
}
