import type { Lead, Conversation } from "./types.js";
/** Clear all leads and conversations; persists empty state. */
export declare function resetMemoryStore(): void;
export declare function getLead(platform: string, userId: string): Promise<Lead | null>;
export declare function createLead(lead: Omit<Lead, "id" | "createdAt" | "updatedAt">): Promise<Lead>;
export declare function updateLead(lead: Lead): Promise<Lead>;
export declare function getConversation(leadId: string): Promise<Conversation>;
export declare function appendMessage(leadId: string, role: "user" | "assistant", text: string): Promise<void>;
//# sourceMappingURL=db.d.ts.map