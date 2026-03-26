/**
 * Module 01: Comment & DM Monitor — detect buyer intent from TikTok/Instagram comments.
 * ManyChat handles ingest; this module may classify intent or pass through.
 */
import type { Lead, Conversation } from "../../core/types.js";
export interface ModuleResult {
    lead: Lead;
    reply: string | null;
}
export declare function process(lead: Lead, _conversation: Conversation): Promise<ModuleResult>;
//# sourceMappingURL=index.d.ts.map