/** Status/planning/stop requests never authorize another execution segment. */
export function executionRequest(message:string):boolean {
  const q=message.trim();
  return !/^(?:stop|pause|cancel|hold off|never mind)\b|\b(?:do not|don't|don’t) (?:act|execute|run|start|continue|extract|export|change|build|do anything)\b|\b(?:just|only) (?:answer|explain|plan|discuss|diagnose)\b|^(?:did|have|has|are|is)\b.{0,80}\b(?:run|finish|done|complete|working|status)\b|^(?:what.{0,30}(?:status|progress|left)|how.{0,20}(?:going|progressing)|where.{0,20}left)\b|\b(?:give|show|compare).{0,25}(?:options|plans)\b/i.test(q);
}
export function needsTaskPlan(message:string):boolean {
  return executionRequest(message)&&/\b(?:all|every|each|extract|export|edit|render|composite|upload|download|research|build|implement|finish|complete|look through|how many|find.{0,30}names)\b/i.test(message)&&! /\b(?:model|pricing|cheaper|expensive)\b/i.test(message);
}
