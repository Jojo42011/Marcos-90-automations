import type { FunnelStage } from "./state.js";
/**
 * Lead — single source of truth per platform + userId.
 */
export interface Lead {
    id: string;
    platform: string;
    userId: string;
    username: string | null;
    name: string | null;
    phone: string | null;
    email: string | null;
    state: FunnelStage;
    source: string | null;
    propertyInquired: string | null;
    criteria: Criteria | null;
    brivityId: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface Criteria {
    priceCap: number | null;
    beds: number | null;
    baths: number | null;
    area: string | null;
}
export interface Message {
    role: "user" | "assistant";
    text: string;
    at: string;
}
export interface Conversation {
    messages: Message[];
}
export interface IncomingWebhookPayload {
    platform: string;
    userId: string;
    username: string | null;
    message: string;
    commentOrDm: "comment" | "dm";
}
//# sourceMappingURL=types.d.ts.map