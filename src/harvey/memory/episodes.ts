import { randomUUID } from "crypto";

import { getMemoryDb } from "./store.js";

function geminiApiKey(): string {
  return process.env.GEMINI_API_KEY?.trim() || "";
}

async function summarizeWithGemini(turns: unknown[]): Promise<string> {
  const key = geminiApiKey();
  if (!key) {
    return "Harvey session completed (Gemini unavailable for summary).";
  }

  const prompt = `Summarize this Harvey conversation in 1-2 sentences. Focus on what was discussed and any decisions made. Conversation: ${JSON.stringify(turns.slice(-6))}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 200 },
      }),
    },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini summarize failed: ${res.status} ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
  return text || "Harvey session completed.";
}

export async function createEpisode(sessionId: string, turns: unknown[]): Promise<void> {
  try {
    const db = getMemoryDb();
    const summaryText = await summarizeWithGemini(turns);
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO harvey_episodes (id, session_id, timestamp, summary, people_involved, emotional_weight, topics, raw_turns, weight)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, sessionId, now, summaryText, "Marco Puga", "routine", "chat", turns.length, 1.0);

    console.log("[Harvey Memory] Episode created:", summaryText.substring(0, 60));
  } catch (err) {
    console.error("[Harvey Memory] Episode creation failed:", err);
  }
}
