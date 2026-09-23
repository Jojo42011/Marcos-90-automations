/** Shared response and session history for Harvey voice and browser chat. */
export interface HarveyChatResponse {
  speech: string;
  sessionId: string;
}

export interface HarveyMemoryTurn {
  role: "user" | "assistant";
  content: string;
  at: string;
}
