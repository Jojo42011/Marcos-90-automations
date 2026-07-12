"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processStyleExample = processStyleExample;
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
const contentDb_js_1 = require("../../core/contentDb.js");
const index_js_1 = require("../../integrations/openshorts/index.js");
async function processStyleExample(id) {
    const example = (0, contentDb_js_1.getStyleExample)(id);
    if (!example) {
        console.warn(`[style-examples] processStyleExample: ${id} not found`);
        return;
    }
    if (!example.filePath) {
        (0, contentDb_js_1.updateStyleExample)(id, { status: "failed", errorMessage: "No file path recorded for this upload" });
        return;
    }
    try {
        const submission = await (0, index_js_1.submitStyleAnalysis)({
            filePath: example.filePath,
            kind: example.kind,
        });
        console.log(`[style-examples] Job submitted for ${id}: ${submission.jobId}`);
        const result = await (0, index_js_1.pollStyleAnalysisJob)(submission.jobId);
        if (result.status === "complete" && result.styleNotes) {
            (0, contentDb_js_1.updateStyleExample)(id, {
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
        }
        else {
            (0, contentDb_js_1.updateStyleExample)(id, {
                status: "failed",
                errorMessage: result.error || "Style analysis did not complete",
            });
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[style-examples] processStyleExample failed for ${id}: ${msg}`);
        (0, contentDb_js_1.updateStyleExample)(id, { status: "failed", errorMessage: msg });
    }
}
