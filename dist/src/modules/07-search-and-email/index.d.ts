/**
 * Module 07: New Home Buddy Search & Email — query listings, build email, send via Gmail + follow-up text.
 */
import type { Lead, Conversation } from "../../core/types.js";
export interface ModuleResult {
    lead: Lead;
    reply: string | null;
}
export declare function process(lead: Lead, _conversation: Conversation): Promise<ModuleResult>;
//# sourceMappingURL=index.d.ts.map