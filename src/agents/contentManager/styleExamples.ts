/**
 * Style examples — reference videos Marco uploads (Upload & Clip → Style
 * Examples zones) so the clipper learns his editing/delivery habits.
 *
 * Two kinds:
 *   "clip" — an already-published, well-performing FINAL clip. Analyzed for
 *            the finished edit: pacing, hook technique, cut rhythm, tone.
 *   "raw"  — unedited source footage. Analyzed for Marco's DELIVERY: energy,
 *            pacing of speech, natural pause/build patterns.
 *
 * Each upload runs through the lightweight OpenShorts sidecar style-analysis
 * endpoint (transcribe + one LLM call, no cutting/reframing) and the
 * resulting brief is persisted. contentDb.getStyleGuideText() aggregates the
 * most recent analyzed briefs and that text rides into EVERY future batch
 * job automatically (see batchProcessor.ts's submitToOpenShorts call).
 */
import {
  type CmStyleExampleKind,
  getStyleExample,
  updateStyleExample,
} from "../../core/contentDb.js";

import { pollStyleAnalysisJob, submitStyleAnalysis } from "../../integrations/openshorts/index.js";

export async function processStyleExample(id: string): Promise<void> {
  const example = getStyleExample(id);
  if (!example) {
    console.warn(`[style-examples] processStyleExample: ${id} not found`);
    return;
  }
  if (!example.filePath) {
    updateStyleExample(id, { status: "failed", errorMessage: "No file path recorded for this upload" });
    return;
  }

  try {
    const submission = await submitStyleAnalysis({
      filePath: example.filePath,
      kind: example.kind as CmStyleExampleKind,
    });
    console.log(`[style-examples] Job submitted for ${id}: ${submission.jobId}`);

    const result = await pollStyleAnalysisJob(submission.jobId);
    if (result.status === "complete" && result.styleNotes) {
      updateStyleExample(id, {
        status: "analyzed",
        styleNotes: result.styleNotes,
        model: result.model || null,
        analyzedAt: new Date().toISOString(),
        // The sidecar deletes the source file once it finishes analyzing —
        // clear the path here so a stray delete-request never 404s on it,
        // and so disk usage never grows from example uploads.
        filePath: null,
      });
      console.log(`[style-examples] ${id} analyzed (${result.styleNotes.length} chars, model=${result.model})`);
    } else {
      updateStyleExample(id, {
        status: "failed",
        errorMessage: result.error || "Style analysis did not complete",
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[style-examples] processStyleExample failed for ${id}: ${msg}`);
    updateStyleExample(id, { status: "failed", errorMessage: msg });
  }
}
