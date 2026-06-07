export type MemoryType = "episodic" | "semantic" | "relational" | "procedural";

export type Episode = {
  id: string;
  sessionId: string;
  timestamp: string;
  summary: string;
  peopleInvolved: string[];
  emotionalWeight: "routine" | "important" | "urgent" | "high_value";
  topics: string[];
  rawTurns: number;
};

export type SemanticMemory = {
  id: string;
  fact: string;
  category: string;
  tags: string[];
  confidence: number;
  accessCount: number;
  lastAccessed: string;
  createdAt: string;
  supersededBy?: string;
  weight: number;
};

export type RelationalMemory = {
  id: string;
  entityA: string;
  relationship: string;
  entityB: string;
  weight: number;
  createdAt: string;
  lastReinforced: string;
};

export type ProceduralMemory = {
  id: string;
  trigger: string;
  action: string;
  category: string;
  useCount: number;
  createdAt: string;
};

export type MemoryRetrievalResult = {
  episodes: Episode[];
  semantic: SemanticMemory[];
  relational: RelationalMemory[];
  procedural: ProceduralMemory[];
  totalScore: number;
};
