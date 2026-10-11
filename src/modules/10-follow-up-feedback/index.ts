import {checkNoReplyFollowups} from "../../agents/emailMarketing/noReplyFollowup.js";
/** Use the existing reply-aware follow-up engine; do not start a second campaign. */
export async function runScheduledFollowUp(): Promise<{sent:number; movedToCold:number}> {
  return checkNoReplyFollowups();
}
