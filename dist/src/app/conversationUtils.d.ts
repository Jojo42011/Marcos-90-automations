import type { Conversation } from "../core/types.js";
/** Normalize for comparing lead messages (repeat taps, etc.). */
export declare function normalizeUserMessageText(text: string): string;
/**
 * True if the latest user message matches the immediately previous user message (normalized).
 */
export declare function isLastUserMessageRepeated(conversation: Conversation): boolean;
/** Same short line twice (e.g. double-tap "yes") — do not treat as stuck/repeat for funnel logic. */
export declare function isShortDuplicateUserPair(conversation: Conversation): boolean;
//# sourceMappingURL=conversationUtils.d.ts.map