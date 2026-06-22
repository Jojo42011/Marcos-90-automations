import {
  createContentSession,
  type ContentPillar,
  type ContentSession,
} from "../../core/contentDb.js";

export type IngestInputType = "video" | "listing_url" | "market_stat" | "calendar";

export interface IngestContentInput {
  type: IngestInputType;
  path?: string;
  url?: string;
  meta?: Record<string, unknown>;
}

export type ContentGeneratorNextStep = "repurpose" | "caption_generator";

export interface IngestContentResult extends ContentSession {
  pillar: ContentPillar;
  nextStep: ContentGeneratorNextStep;
}

function classifyPillar(type: IngestInputType, meta?: Record<string, unknown>): ContentPillar {
  const text = JSON.stringify(meta ?? {}).toLowerCase();
  if (type === "listing_url") return "listings";
  if (type === "video") {
    if (/\b(testimonial|win|marco|wesley|brand)\b/.test(text)) return "brand";
    if (/\b(listing|tour|sold|listed)\b/.test(text)) return "listings";
    return "brand";
  }
  if (type === "market_stat" || type === "calendar") return "education";
  return "education";
}

function resolveNextStep(type: IngestInputType): ContentGeneratorNextStep {
  return type === "video" ? "repurpose" : "caption_generator";
}

/**
 * Creates a content_sessions record and returns session metadata for downstream chaining.
 * Does not call repurpose/caption modules directly.
 */
export async function ingestContent(input: IngestContentInput): Promise<IngestContentResult> {
  const pillar = classifyPillar(input.type, input.meta);
  const nextStep = resolveNextStep(input.type);
  const rawInputPath = input.path?.trim() || input.url?.trim() || null;

  const session = createContentSession({
    rawInputType: input.type,
    rawInputPath,
    rawInputMeta: {
      ...(input.meta ?? {}),
      pillar,
      nextStep,
      sourceUrl: input.url ?? null,
    },
    status: "processing",
  });

  console.log(
    `[content-manager/ingest] session ${session.id} type=${input.type} pillar=${pillar} next=${nextStep}`,
  );

  return {
    ...session,
    pillar,
    nextStep,
  };
}
