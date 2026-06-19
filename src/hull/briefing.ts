import { getSystemState, setSystemState } from "./memory/store.js";
import Anthropic from "@anthropic-ai/sdk";
import { getHaikuModel } from "./modelRouting.js";

const LAST_BRIEFED_DATE_KEY = "last_briefed_date";

export function getOhioDateString(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function getTimeAwareGreeting(): string {
  const hour = parseInt(
    new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }),
    10,
  );
  if (hour < 12) return "Good morning sir.";
  if (hour < 17) return "Good afternoon sir.";
  return "Good evening sir.";
}

export async function handleActivation(memoryPacket: string): Promise<string> {
  const today = getOhioDateString();
  const lastBriefed = getSystemState(LAST_BRIEFED_DATE_KEY);
  if (today !== lastBriefed) {
    const brief = await generateBrief(memoryPacket);
    setSystemState(LAST_BRIEFED_DATE_KEY, today);
    return brief;
  }
  return `${getTimeAwareGreeting()} What do you need?`;
}

export async function generateBrief(memoryPacket: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return getTimeAwareGreeting() + " Systems are online.";

  const client = new Anthropic({ apiKey: key });
  try {
    const res = await client.messages.create({
      model: getHaikuModel(),
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `Generate a morning brief for Marco Puga (real estate agent). Max 4 sentences, spoken aloud. Most urgent first. Max 3 items. Open with time-aware greeting. If nothing new: "All clear sir. What do you need?" Context:\n${memoryPacket.slice(0, 2000)}`,
        },
      ],
    });
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("")
      .trim();
    return text || getTimeAwareGreeting();
  } catch {
    return getTimeAwareGreeting();
  }
}

export function scheduleMorningBriefing(onBrief: (text: string) => void): void {
  const scheduleNext = () => {
    const now = new Date();
    const target = new Date(now);
    target.setHours(7, 0, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    const delay = target.getTime() - now.getTime();
    setTimeout(async () => {
      const { searchFacts, getMemoryPacket } = await import("./memory/retrieval.js");
      const facts = await searchFacts("morning business priorities", 8);
      const packet = getMemoryPacket("morning brief", facts);
      const brief = await generateBrief(packet);
      onBrief(brief);
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}
