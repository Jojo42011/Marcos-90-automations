"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executionRequest = executionRequest;
exports.needsTaskPlan = needsTaskPlan;
exports.taskFollowup = taskFollowup;
exports.segmentLimit = segmentLimit;
/** Status/planning/stop requests never authorize another execution segment. */
function executionRequest(message) {
    const q = message.trim();
    return !/^(?:stop|pause|cancel|hold off|never mind)\b|\b(?:do not|don't|don’t) (?:act|execute|run|start|continue|extract|export|change|build|do anything)\b|\b(?:just|only) (?:answer|explain|plan|discuss|diagnose)\b|^(?:did|have|has|are|is)\b.{0,80}\b(?:run|finish|done|complete|working|status)\b|^(?:what.{0,30}(?:status|progress|left)|how.{0,20}(?:going|progressing)|where.{0,20}left)\b|\b(?:give|show|compare).{0,25}(?:options|plans)\b/i.test(q);
}
function needsTaskPlan(message) {
    return executionRequest(message) && /\b(?:all|every|each|extract|export|edit|render|composite|upload|download|research|build|implement|finish|complete|look through|how many|find.{0,30}names|log\s*in|sign\s*in|start\b.{0,30}\d+|\d+\s+(?:leads|records|contacts))\b/i.test(message) && !/\b(?:model|pricing|cheaper|expensive)\b/i.test(message);
}
/** Short follow-ups inherit only an existing task, never an unrelated old request. */
function taskFollowup(message) {
    return executionRequest(message) && /^\s*(?:(?:yes|ok|okay)[,.!]?\s*)?(?:continue|conitnue|contine|resume|finish|keep going|go ahead|(?:oh[, ]+)?(?:i meant|actually)|(?:please\s+)?(?:exclude|include|skip))\b/i.test(message);
}
function segmentLimit(reason) {
    return /\b(?:turn|step|execution) (?:budget|limit)|\bfinal round\b/i.test(reason) && !/\b(?:24.hour|256|monthly|credits|provider|rate limit)\b/i.test(reason);
}
