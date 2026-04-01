/**
 * Module 08: CRM Entry — Brivity Auto-Sync. Create/update contact with full lead details.
 */
import type { Lead, Conversation } from "../../core/types.js";
export interface ModuleResult {
    lead: Lead;
    reply: string | null;
}
export declare function process(lead: Lead, _conversation: Conversation): Promise<ModuleResult>;
//# sourceMappingURL=index.d.ts.map