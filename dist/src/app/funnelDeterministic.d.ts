/**
 * Deterministic funnel transitions and field extraction (phone, email, criteria regex).
 * Reply text is generated separately by Claude in the pipeline.
 */
import type { Lead, Conversation } from "../core/types.js";
export interface FunnelDeterministicMeta {
    phoneJustCaptured?: boolean;
    /** Advanced to Closed this turn (module 07 equivalent — personalized list email next). */
    listSendPromised?: boolean;
}
export declare function extractPhone(text: string): string | null;
/**
 * Apply regex extractions and stage transitions for one inbound turn (after user message is appended).
 */
export declare function advanceFunnelDeterministic(lead: Lead, conversation: Conversation): {
    lead: Lead;
    meta: FunnelDeterministicMeta;
};
//# sourceMappingURL=funnelDeterministic.d.ts.map