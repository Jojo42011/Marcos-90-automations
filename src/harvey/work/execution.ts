/** Status/planning/stop requests never authorize another execution segment. */
export function executionRequest(message:string):boolean {
  const q=message.trim();
  return !/^(?:stop|pause|cancel|hold off|never mind)\b|\b(?:do not|don't|don’t) (?:act|execute|run|start|continue|extract|export|change|build|do anything)\b|\b(?:just|only) (?:answer|explain|plan|discuss|diagnose)\b|^(?:did|have|has|are|is)\b.{0,80}\b(?:run|finish|done|complete|working|status)\b|^(?:what.{0,30}(?:status|progress|left)|how.{0,20}(?:going|progressing)|where.{0,20}left)\b|\b(?:give|show|compare).{0,25}(?:options|plans)\b/i.test(q);
}
export function needsTaskPlan(message:string):boolean {
  return executionRequest(message)&&/\b(?:all|every|each|extract|export|edit|render|composite|upload|download|research|build|implement|finish|complete|look through|how many|find.{0,30}names|log\s*in|sign\s*in|start\b.{0,30}\d+|\d+\s+(?:leads|records|contacts))\b/i.test(message)&&! /\b(?:model|pricing|cheaper|expensive)\b/i.test(message);
}

/** Short follow-ups inherit only an existing task, never an unrelated old request. */
export function taskFollowup(message:string):boolean {
  const confirmedConnection=message.length<150&&!message.includes('?')&&/^\s*(?:(?:I(?:'ve| have)?\s+)?(?:connected|authorized|signed in|logged in)\b|(?:google sheets|sheets|google) (?:is|are) (?:connected|authorized)\b)/i.test(message);
  return executionRequest(message)&&(confirmedConnection||/^\s*(?:(?:yes|ok|okay)[,.!]?\s*)?(?:continue|conitnue|contine|resume|finish|keep going|go ahead|do it|(?:oh[, ]+)?(?:i meant|actually)|(?:please\s+)?(?:exclude|include|skip))\b/i.test(message)||message.length<300&&/\b(?:try again|retry|pick up where you left off|do whatever you can|(?:authorize|connect).{0,60}(?:then|and).{0,30}(?:do|finish|continue))\b/i.test(message));
}

/** Referring to the original first-N selection is not a new, weaker task. */
export function resumedTaskGoal(message:string,original:string):string {
  const count=/\bfirst\s+(\d+)\b/i.exec(message),prior=/\bfirst\s+(\d+)\b/i.exec(original);
  const reference=/\b(?:original|existing|same)\b/i.test(message);
  const changed=/\b(?:actually|instead|exclude|include|skip|change|only)\b/i.test(message)||/\bfirst\b/i.test(message)&&(!reference||!!count&&count[1]!==prior?.[1]);
  return changed?message:original;
}

export function segmentLimit(reason:string):boolean {
  return /\b(?:turn|step|execution) (?:budget|limit)|\bfinal round\b/i.test(reason) && !/\b(?:24.hour|256|monthly|credits|provider|rate limit)\b/i.test(reason);
}

/** Auxiliary advice only; this ceiling does not limit the task's tool actions. */
export function recoveryReviewPolicy(){return {model:process.env.HARVEY_RECOVERY_MODEL||'anthropic/claude-sonnet-4.6',maxCostUsd:.05,readOnly:true,mainModelUnchanged:true};}

/** Optional semantic review complements native receipt/hash checks, never replaces them. */
export function outcomeReviewPolicy(){return {model:process.env.HARVEY_OUTCOME_AUDIT_MODEL||recoveryReviewPolicy().model,maxCostUsd:.05,readOnly:true,mainModelUnchanged:true};}
