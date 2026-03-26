import type { Lead, Conversation } from "../../core/types.js";
export interface ModuleResult {
    lead: Lead;
    reply: string | null;
}
export interface OpeningProcessOptions {
    /** Combined preflight + deterministic duplicate detection */
    treatAsRepeat: boolean;
    coachingNote: string;
}
export declare function process(lead: Lead, conversation: Conversation, options?: OpeningProcessOptions): Promise<ModuleResult>;
//# sourceMappingURL=index.d.ts.map