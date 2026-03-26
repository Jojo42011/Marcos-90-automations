import type { IncomingWebhookPayload } from "../core/types.js";
export declare function handleIncomingPayload(payload: IncomingWebhookPayload): Promise<{
    status: number;
    reply?: string;
}>;
export declare function handleWebhook(body: unknown): Promise<{
    status: number;
    reply?: string;
}>;
//# sourceMappingURL=webhook.d.ts.map