/**
 * Sinch Conversation API — outbound SMS and inbound webhook parsing.
 */
import "dotenv/config";
import type { IncomingWebhookPayload } from "../../core/types.js";
/**
 * Send an SMS via Sinch Conversation API messages:send.
 * Returns false if env incomplete or request fails (logs, does not throw).
 */
export declare function sendSMS(toNumber: string, message: string): Promise<boolean>;
/**
 * Map Sinch inbound callback body to our pipeline shape.
 * Supports common nested layouts (message + contact, or wrapped events).
 */
export declare function receiveInbound(payload: unknown): IncomingWebhookPayload | null;
//# sourceMappingURL=index.d.ts.map