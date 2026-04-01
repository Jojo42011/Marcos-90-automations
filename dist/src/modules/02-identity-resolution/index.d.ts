/**
 * Module 02: Identity Resolution — resolve real name from username/profile; polite name request if not.
 */
import type { Lead, Conversation } from "../../core/types.js";
export interface ModuleResult {
    lead: Lead;
    reply: string | null;
}
export declare function process(lead: Lead, _conversation: Conversation): Promise<ModuleResult>;
//# sourceMappingURL=index.d.ts.map