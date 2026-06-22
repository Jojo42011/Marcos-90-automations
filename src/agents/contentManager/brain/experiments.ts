import { randomUUID } from "crypto";
import type { ContentManagerBrain } from "./index.js";
import {
  assignVideoToExperiment as dbAssignVideo,
  getActiveExperiment,
  getExperimentForWeek,
  insertExperiment,
  listExperiments,
  listHookLibrary,
  getPerformanceModel,
  listCombinationPatterns,
  getVideoPerformanceAvg,
  updateExperiment,
} from "../../../core/contentDb.js";
import { getHookTypePerformanceSummary } from "./hookClassifier.js";
import { getWeekStart, isMonday } from "./stats.js";

function parseJson<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export async function proposeWeeklyExperiment(brain: ContentManagerBrain): Promise<void> {
  if (!isMonday()) return;

  const active = getActiveExperiment();
  if (active && (active.status === "running" || active.status === "proposed")) {
    return;
  }

  const model = getPerformanceModel();
  const combinations = listCombinationPatterns({ minSamples: 2, limit: 10, order: "desc" });
  const hookSummary = getHookTypePerformanceSummary();

  const prompt = `Based on this performance data: ${JSON.stringify(model)}, top combinations: ${JSON.stringify(combinations)}, hook type summary: ${JSON.stringify(hookSummary)} — propose ONE small experiment for this week. Test exactly ONE variable achievable with content in the pipeline. Return JSON only: { "hypothesis": string, "variable_tested": string, "control_description": string, "test_description": string }`;

  const raw = await brain.chat(prompt);
  const parsed = parseJson<{
    hypothesis: string;
    variable_tested: string;
    control_description: string;
    test_description: string;
  }>(raw);

  if (!parsed?.hypothesis) return;

  insertExperiment({
    weekStart: getWeekStart(),
    hypothesis: parsed.hypothesis,
    variableTested: parsed.variable_tested || "hook_type",
    controlDescription: parsed.control_description || "",
    testDescription: parsed.test_description || "",
    status: "proposed",
  });

  console.log(`[cm-brain] Weekly experiment proposed: ${parsed.hypothesis}`);
}

export async function evaluateCurrentExperiment(brain: ContentManagerBrain): Promise<void> {
  const weekStart = getWeekStart();
  const exp = getExperimentForWeek(weekStart) ?? getActiveExperiment();
  if (!exp || (exp.status !== "running" && exp.status !== "proposed")) return;

  const controlIds: string[] = JSON.parse(exp.controlVideoIds || "[]");
  const testIds: string[] = JSON.parse(exp.testVideoIds || "[]");

  const controlAvg = getVideoPerformanceAvg(controlIds);
  const testAvg = getVideoPerformanceAvg(testIds);

  if (controlIds.length < 2 || testIds.length < 2) {
    updateExperiment(exp.id, {
      status: "abandoned",
      conclusion: "Insufficient data to evaluate.",
      evaluatedAt: new Date().toISOString(),
    });
    return;
  }

  let result: "test_won" | "control_won" | "inconclusive" = "inconclusive";
  if (testAvg > controlAvg * 1.1) result = "test_won";
  else if (controlAvg > testAvg * 1.1) result = "control_won";

  const raw = await brain.chat(
    `Experiment result: control avg ${controlAvg} vs test avg ${testAvg}. Hypothesis: ${exp.hypothesis}. Result: ${result}. Return JSON: { "conclusion": string, "learning": string }`,
  );
  const parsed = parseJson<{ conclusion: string; learning: string }>(raw);

  updateExperiment(exp.id, {
    controlAvgViews: controlAvg,
    testAvgViews: testAvg,
    result,
    conclusion: parsed?.conclusion || parsed?.learning || "Experiment complete.",
    status: "complete",
    evaluatedAt: new Date().toISOString(),
  });

  if (result === "test_won" && exp.variableTested === "hook_type") {
    const hooks = listHookLibrary({ minUses: 1, limit: 50, order: "desc" });
    console.log(`[cm-brain] Experiment test won — ${hooks.length} hooks in library`);
  }
}

export function assignVideoToExperiment(videoId: string): void {
  dbAssignVideo(videoId);
}
