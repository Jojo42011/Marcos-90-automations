/**
 * Module 06: Criteria Pivot & Email Extraction — collect criteria and email when property doesn't fit.
 */
import type { Lead, Conversation } from "../../core/types.js";
export interface ModuleResult {
    lead: Lead;
    reply: string | null;
}
export declare function process(lead: Lead, conversation: Conversation): Promise<ModuleResult>;
//# sourceMappingURL=index.d.ts.map