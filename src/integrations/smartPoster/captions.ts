/**
 * Caption drafts modeled on recent Zernio captions for this account's platforms.
 */
import Anthropic from "@anthropic-ai/sdk";
import { fetchAllZernioAccountAnalytics } from "../zernio/index.js";

const PLATFORM_ALIASES: Record<string, string> = {
  tt: "tiktok",
  tiktok: "tiktok",
  ig: "instagram",
  instagram: "instagram",
  insta: "instagram",
  fb: "facebook",
  facebook: "facebook",
  yt: "youtube",
  youtube: "youtube",
  all: "all",
};

export function normalizePlatform(raw: string): string | null {
  const key = String(raw || "").trim().toLowerCase();
  return PLATFORM_ALIASES[key] || null;
}

/** Parse `YYYY-MM-DD__platform__slug.ext` (or looser variants). */
export function parseVideoFileName(fileName: string): {
  targetDate: string | null;
  platforms: string[];
  slug: string;
} {
  const base = fileName.replace(/\.[^.]+$/, "");
  const parts = base.split("__").map((p) => p.trim()).filter(Boolean);
  let targetDate: string | null = null;
  let platforms: string[] = ["all"];
  let slug = base;

  if (parts.length >= 1 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0])) {
    targetDate = parts[0];
    if (parts.length >= 2) {
      const plat = normalizePlatform(parts[1]);
      if (plat === "all") platforms = ["all"];
      else if (plat) platforms = [plat];
      else {
        /* treat second segment as slug start */
        slug = parts.slice(1).join(" ");
        return { targetDate, platforms, slug };
      }
      slug = parts.slice(2).join(" ") || parts[1];
    }
  } else {
    slug = parts.join(" ") || base;
  }

  slug = slug.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return { targetDate, platforms, slug };
}

export async function recentCaptionsForPlatforms(
  platforms: string[],
  limit = 12,
): Promise<string[]> {
  const analytics = await fetchAllZernioAccountAnalytics();
  if (!analytics.ok) return [];
  const wantAll = platforms.includes("all") || !platforms.length;
  const want = new Set(platforms.filter((p) => p !== "all"));
  const captions: string[] = [];
  for (const r of analytics.results) {
    if (!r.ok || !r.stats) continue;
    const plat = String(r.platform || "").toLowerCase();
    if (!wantAll && !want.has(plat)) continue;
    for (const post of r.stats.postsDetail || []) {
      const c = String(post.caption || "").trim();
      if (c.length > 20) captions.push(c);
      if (captions.length >= limit) return captions;
    }
  }
  return captions;
}

function heuristicCaption(slug: string, samples: string[]): string {
  const hashtagLine = samples
    .join(" ")
    .match(/#[\w]+/g)
    ?.slice(0, 6)
    .join(" ");
  const opener = slug
    ? `${slug.charAt(0).toUpperCase()}${slug.slice(1)}.`
    : "New listing walkthrough.";
  return hashtagLine ? `${opener}\n\n${hashtagLine}` : opener;
}

export async function draftCaption(input: {
  slug: string;
  platforms: string[];
  sidecarCaption?: string | null;
}): Promise<string> {
  if (input.sidecarCaption?.trim()) return input.sidecarCaption.trim();

  const samples = await recentCaptionsForPlatforms(input.platforms);
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key || !samples.length) return heuristicCaption(input.slug, samples);

  try {
    const anthropic = new Anthropic({ apiKey: key });
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 280,
      system:
        "You write short social video captions for a Texas real estate creator. "
        + "Match the voice, pacing, emoji density and hashtag style of the EXAMPLES. "
        + "Return ONLY the caption text — no quotes, no preamble.",
      messages: [
        {
          role: "user",
          content:
            `Video topic / filename slug: ${input.slug || "(untitled)"}\n`
            + `Platforms: ${(input.platforms.includes("all") ? ["tiktok", "instagram"] : input.platforms).join(", ")}\n\n`
            + `EXAMPLES from this account:\n`
            + samples
              .slice(0, 8)
              .map((c, i) => `${i + 1}. ${c.slice(0, 400)}`)
              .join("\n\n"),
        },
      ],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => ("text" in b ? b.text : ""))
      .join("")
      .trim();
    return text || heuristicCaption(input.slug, samples);
  } catch {
    return heuristicCaption(input.slug, samples);
  }
}
