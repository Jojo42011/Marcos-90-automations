import {
  getContentDb,
  listHookLibrary,
  type CmHookLibraryEntry,
} from "../../../core/contentDb.js";

export const HOOK_TYPES = {
  question: "question",
  shock: "shock",
  personal_story: "personal_story",
  data: "data",
  controversy: "controversy",
  local: "local",
  uncategorized: "uncategorized",
} as const;

const LOCAL_TERMS = [
  "stone oak",
  "canyon lake",
  "new braunfels",
  "san antonio",
  "alamo heights",
  "78209",
  "78258",
  "78259",
];

function buildHookStructure(hookText: string): string {
  return hookText
    .replace(/\$[\d,]+(?:\.\d+)?[kKmM]?/g, "[amount]")
    .replace(/\b\d+(?:\.\d+)?%/g, "[percent]")
    .replace(/\b\d{1,2}\/\d{1,2}\b/g, "[beds]/[baths]")
    .replace(/\b\d{3,}[\d,]*\b/g, "[number]")
    .replace(
      /\b(Stone Oak|Canyon Lake|New Braunfels|San Antonio|Alamo Heights)\b/gi,
      "[neighborhood]",
    )
    .trim();
}

export function classifyHook(hookText: string): {
  hookType: string;
  hookStructure: string;
  confidence: number;
} {
  const text = hookText.trim();
  const lower = text.toLowerCase();
  const signals: string[] = [];

  if (/^(did you|what if|are you|do you|how|why|is it|can you)\b/i.test(lower) || text.endsWith("?")) {
    signals.push("question");
  }
  if (
    /\b(just sold|just closed|won't tell you|wont tell you|most agents|nobody tells)\b/i.test(
      lower,
    )
  ) {
    signals.push("shock");
  }
  if (/\b(last week|my client|i was|i just)\b/i.test(lower)) {
    signals.push("personal_story");
  }
  const head = text.slice(0, 30);
  if (/\$[\d,]+|\d+(?:\.\d+)?%|\d+\s*homes|\d+\s*days/i.test(head)) {
    signals.push("data");
  }
  if (/\b(stop|mistake|wrong|terrible|everyone gets|gets this wrong)\b/i.test(lower)) {
    signals.push("controversy");
  }
  if (LOCAL_TERMS.some((t) => lower.includes(t))) {
    signals.push("local");
  }

  const hookType = signals[0] ?? HOOK_TYPES.uncategorized;
  const confidence = signals.length >= 2 ? 0.9 : signals.length === 1 ? 0.7 : 0.5;

  return {
    hookType,
    hookStructure: buildHookStructure(text),
    confidence,
  };
}

export function classifyAndUpdateHookLibrary(): number {
  const database = getContentDb();
  const rows = database
    .prepare(
      `SELECT id, hook_text FROM cm_hook_library
       WHERE hook_type IS NULL OR hook_type = 'uncategorized' OR classified_at IS NULL`,
    )
    .all() as Array<{ id: string; hook_text: string }>;

  const now = new Date().toISOString();
  let updated = 0;
  for (const row of rows) {
    const { hookType, hookStructure } = classifyHook(row.hook_text);
    database
      .prepare(
        `UPDATE cm_hook_library SET hook_type = ?, hook_structure = ?, classified_at = ? WHERE id = ?`,
      )
      .run(hookType, hookStructure, now, row.id);
    updated++;
  }
  return updated;
}

export function getHookTypePerformanceSummary(): Record<
  string,
  { avg_views: number; above_benchmark_rate: number; sample_count: number }
> {
  const rows = getContentDb()
    .prepare(
      `SELECT hook_type,
              AVG(avg_views_when_used) AS avg_views,
              SUM(times_used) AS sample_count,
              SUM(times_above_benchmark) AS above_count
       FROM cm_hook_library
       WHERE times_used >= 2 AND hook_type IS NOT NULL
       GROUP BY hook_type`,
    )
    .all() as Array<{
    hook_type: string;
    avg_views: number;
    sample_count: number;
    above_count: number;
  }>;

  const out: Record<string, { avg_views: number; above_benchmark_rate: number; sample_count: number }> =
    {};
  for (const r of rows) {
    const sample = Number(r.sample_count) || 0;
    const above = Number(r.above_count) || 0;
    out[r.hook_type] = {
      avg_views: Math.round(Number(r.avg_views) || 0),
      above_benchmark_rate: sample > 0 ? above / sample : 0,
      sample_count: sample,
    };
  }
  return out;
}

export function getHookLibraryEntries(minUses = 1): CmHookLibraryEntry[] {
  return listHookLibrary({ minUses, limit: 500, order: "desc" });
}
