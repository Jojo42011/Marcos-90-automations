import type { Lead, IncomingWebhookPayload } from "../core/types.js";
export interface PipelineResult {
    reply: string | null;
    /** Null when a brand-new contact failed the buyer-intent gate (no lead created). */
    lead: Lead | null;
}
export declare function run(payload: IncomingWebhookPayload): Promise<PipelineResult>;
//# sourceMappingURL=pipeline.d.ts.map