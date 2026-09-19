"use strict";
/**
 * The contract for Harvey's model-provider layer.
 *
 * WHY THIS FILE EXISTS FIRST. Everything under Harvey used to call the
 * Anthropic SDK directly, with model ids hardcoded in `modelRouting.ts`. That
 * makes "switch to Gemini for this turn" a code change and makes cost invisible.
 * This layer puts one seam between Harvey and whoever actually runs the tokens,
 * so the model becomes data (a picker in the UI, a row in a table) instead of a
 * deploy.
 *
 * THE INTERNAL MESSAGE FORMAT STAYS ANTHROPIC-SHAPED. ~120 tool definitions,
 * the agent loop, the memory extractor and the job runner are all written
 * against Anthropic's `MessageParam` / `Tool` types. Rewriting them to a new
 * neutral format would be a large, risky change for no user-visible gain, so
 * translation happens at the boundary (`translate.ts`) and the rest of the
 * codebase does not move.
 *
 * ONE KEY, MANY MODELS. OpenRouter is the primary provider because it is
 * OpenAI-compatible, exposes 400+ models behind a single `OPENROUTER_API_KEY`,
 * returns real cost per request in the response body (so spend is measured, not
 * estimated), and supports a model fallback chain server-side. Direct Anthropic
 * stays wired as a fallback so an absent OpenRouter key cannot take Harvey down.
 */
Object.defineProperty(exports, "__esModule", { value: true });
