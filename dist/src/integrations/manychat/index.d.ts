/**
 * ManyChat — webhook payload types, optional outbound API to send DMs.
 */
export type ManyChatWebhookPayload = Record<string, unknown>;
export declare function sendDM(_userId: string, _text: string): Promise<void>;
//# sourceMappingURL=index.d.ts.map