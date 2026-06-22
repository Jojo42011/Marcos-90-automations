/**
 * Google Gemini client for the Content Manager Brain.
 */

export interface CmBrainToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export type CmBrainChatMessage = { role: "user" | "model"; parts: GeminiPart[] };

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
}

export function getGeminiApiKey(): string | null {
  return process.env.GEMINI_API_KEY?.trim() || null;
}

export function getCmBrainModel(): string {
  return (
    process.env.CONTENT_BRAIN_MODEL?.trim() ||
    process.env.GEMINI_MODEL?.trim() ||
    "gemini-2.5-flash"
  );
}

export function getCmBrainMiniModel(): string {
  return (
    process.env.CONTENT_BRAIN_MINI_MODEL?.trim() ||
    process.env.GEMINI_MINI_MODEL?.trim() ||
    "gemini-2.5-flash"
  );
}

function toGeminiSchemaNode(node: unknown): Record<string, unknown> {
  if (!node || typeof node !== "object") return { type: "STRING" };
  const o = node as Record<string, unknown>;

  if (o.type === "object") {
    const properties: Record<string, unknown> = {};
    const props = o.properties as Record<string, unknown> | undefined;
    if (props) {
      for (const [key, val] of Object.entries(props)) {
        properties[key] = toGeminiSchemaNode(val);
      }
    }
    return {
      type: "OBJECT",
      properties,
      required: Array.isArray(o.required) ? o.required : [],
    };
  }

  if (o.type === "array") {
    return {
      type: "ARRAY",
      items: toGeminiSchemaNode(o.items),
      description: o.description,
    };
  }

  const typeMap: Record<string, string> = {
    string: "STRING",
    number: "NUMBER",
    integer: "INTEGER",
    boolean: "BOOLEAN",
  };
  const geminiType = typeMap[String(o.type)] || "STRING";
  const out: Record<string, unknown> = { type: geminiType };
  if (o.description) out.description = o.description;
  if (Array.isArray(o.enum)) out.enum = o.enum;
  return out;
}

export function toGeminiFunctionDeclarations(defs: CmBrainToolDefinition[]) {
  return defs.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: toGeminiSchemaNode(t.input_schema),
  }));
}

async function geminiGenerateContent(input: {
  system: string;
  contents: CmBrainChatMessage[];
  tools?: CmBrainToolDefinition[];
  model?: string;
  maxTokens?: number;
}): Promise<GeminiPart[]> {
  const key = getGeminiApiKey();
  if (!key) throw new Error("GEMINI_API_KEY not configured");

  const model = input.model ?? getCmBrainModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: input.system }] },
    contents: input.contents,
    generationConfig: { maxOutputTokens: input.maxTokens ?? 4096 },
  };

  if (input.tools?.length) {
    body.tools = [{ functionDeclarations: toGeminiFunctionDeclarations(input.tools) }];
    body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = (await res.json()) as GeminiGenerateResponse;
  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts?.length) throw new Error("Gemini returned no content");
  return parts;
}

function extractText(parts: GeminiPart[]): string {
  return parts
    .map((p) => ("text" in p ? p.text : ""))
    .join("")
    .trim();
}

function extractFunctionCalls(parts: GeminiPart[]): Array<{ name: string; args: Record<string, unknown> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const p of parts) {
    if ("functionCall" in p && p.functionCall?.name) {
      calls.push({
        name: p.functionCall.name,
        args: p.functionCall.args ?? {},
      });
    }
  }
  return calls;
}

export async function geminiChatWithTools(input: {
  system: string;
  userMessage: string;
  history?: CmBrainChatMessage[];
  tools: CmBrainToolDefinition[];
  model?: string;
  maxRounds?: number;
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}): Promise<string> {
  const contents: CmBrainChatMessage[] = [...(input.history ?? [])];
  contents.push({ role: "user", parts: [{ text: input.userMessage }] });
  const maxRounds = input.maxRounds ?? 8;

  for (let round = 0; round < maxRounds; round++) {
    const parts = await geminiGenerateContent({
      system: input.system,
      contents,
      tools: input.tools,
      model: input.model,
    });

    const calls = extractFunctionCalls(parts);
    if (calls.length === 0) {
      return extractText(parts) || "No response generated.";
    }

    contents.push({ role: "model", parts });

    const responses: GeminiPart[] = [];
    for (const call of calls) {
      const result = await input.onToolCall(call.name, call.args);
      const responseObj =
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : { result };
      responses.push({
        functionResponse: { name: call.name, response: responseObj },
      });
    }
    contents.push({ role: "user", parts: responses });
  }

  return "Reached maximum tool rounds — try a more specific question.";
}

/** Simple single-turn completion (hooks, captions). */
export async function geminiSimpleChat(userPrompt: string, model?: string): Promise<string> {
  const parts = await geminiGenerateContent({
    system: "You are a concise copywriter for Marco Puga Realty. Return only what is asked.",
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    model: model ?? getCmBrainMiniModel(),
    maxTokens: 600,
  });
  return extractText(parts);
}
