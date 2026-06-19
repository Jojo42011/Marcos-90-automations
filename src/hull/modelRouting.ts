const SONNET_TRIGGERS = [
  "marco",
  "arthur",
  "joe",
  "gus",
  "client",
  "remember",
  "recall",
  "store",
  "learned",
  "memory",
  "graph",
  "read",
  "write",
  "list",
  "edit",
  "file",
  "build",
  "deploy",
  "fix",
  "analyze",
  "code",
  "search",
  "look up",
  "find",
  "what is",
  "price",
  "email",
  "calendar",
  "send",
  "book",
  "schedule",
  "lead",
  "tiktok",
  "instagram",
  "funnel",
  "mojo",
  "brivity",
  "transaction",
  "showing",
  "listing",
];

export function needsSonnet(message: string): boolean {
  const lower = message.toLowerCase();
  return SONNET_TRIGGERS.some((t) => lower.includes(t));
}

export function getAethonModel(): string {
  return (
    process.env.AETHON_MODEL?.trim() ||
    process.env.HARVEY_MODEL?.trim() ||
    "claude-sonnet-4-6"
  );
}

export function getHaikuModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5-20251001";
}

export function getMaxTokens(): number {
  const n = parseInt(process.env.AETHON_MAX_TOKENS || "8192", 10);
  return Number.isFinite(n) ? n : 8192;
}
