/**
 * Conversational clip-editing agent (Review Queue chat).
 *
 * A Sonnet tool-calling agent (reusing claudeChatWithTools — the same loop
 * Harvey uses) that interprets plain-language edit requests for ONE clip and
 * either applies cheap copy changes immediately or PROPOSES an expensive video
 * edit for explicit confirmation. It never renders video itself — propose_video_edit
 * returns a structured proposal that the UI confirms, which then calls the
 * existing /api/content/clip/:id/edit engine.
 */
import { claudeChatWithTools, type CmBrainToolDefinition, type CmBrainChatMessage } from "./brain/claudeTools.js";
import { CONTENT_MODELS, claudeContent, logContentAiFailure } from "../../integrations/claude-content.js";
import { getContentVideo, updateContentVideo } from "../../core/contentDb.js";

export interface ClipEditContext {
  clipId: string;
  hook: string;
  caption: string;
  hashtags: string[];
  score: number;
  durationSeconds: number | null;
  hasPreviousVersion: boolean;
  captions: Array<{ start: number; end: number; text: string }>;
  captionsEditable: boolean;
}

export interface ClipEditProposal {
  summary: string; // plain-language description shown to Marco for confirmation
  spec: {
    trim?: { start: number; end: number } | null;
    cuts?: Array<[number, number]>;
    audio?: "keep" | "mute" | "remove" | "replace";
    color?: "auto" | "warm" | "cool" | "punch" | "flat";
    effects?: Array<{ type: "zoom_in" | "zoom_out" | "punch_in"; start: number; end: number; amount?: number }>;
    autoTighten?: boolean;
    snapToScenes?: boolean;
  };
}

const CLIP_EDIT_SYSTEM = `You are Marco Puga's clip-editing assistant inside the Review Queue. You help edit ONE short vertical real-estate clip that Marco describes in plain language.

Two kinds of change:
1. COPY (hook / caption / hashtags text) — cheap, instant, reversible. Use update_clip_copy. Never ask permission for these.
2. VIDEO (trim the ends, remove a middle section, change the audio, remove dead air / bloopers, colour-correct, or add a zoom / punch-in) — EXPENSIVE (a re-render). Use propose_video_edit, which only PROPOSES the change. Never claim a video edit is done from a proposal — the human must confirm it separately.

Rules:
- The clip's hook/caption/hashtags/captions AND its real duration (duration_seconds) are already provided in CURRENT CLIP CONTEXT below — you start every conversation knowing them. Never say you don't have the clip's length; if duration_seconds is a number, that IS the total length. Only call get_clip_context to re-read after a change.
- Use duration_seconds to resolve end-relative requests directly, without asking. "Delete/trim the last N seconds" → propose a trim from start=0 to end=(duration_seconds − N). "Cut the first N seconds" → trim from start=N to end=duration_seconds. Do the arithmetic yourself; do not ask Marco for the length you already have.
- Convert time references ("around 0:14", "where I say the wrong price") into concrete second values using the caption lines' timings in the context. If you cannot confidently locate the moment, ASK a clarifying question — do NOT guess and do NOT propose a render on a vague instruction.
- For a vague copy request ("make it punchier") you may go ahead (copy is cheap and reversible); for a vague VIDEO request, ask first.
- After proposing a video edit, tell Marco exactly what you'll do in plain language and ask him to confirm.
- Keep replies short and in Marco's direct, first-person, San-Antonio-realtor voice. No corporate filler.`;

const TOOLS: CmBrainToolDefinition[] = [
  {
    name: "get_clip_context",
    description: "Read the current clip's hook, caption, hashtags, score, duration, and caption lines (with timings). Call before discussing specifics.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "update_clip_copy",
    description: "Change the clip's hook, caption, or hashtags text. Executes immediately (cheap, reversible). Use for copy only — never video.",
    input_schema: {
      type: "object",
      properties: {
        field: { type: "string", enum: ["hook", "caption", "hashtags"] },
        direction: { type: "string", description: "What to change and how, e.g. 'make it punchier', 'lead with the price', 'add #stoneoak'." },
      },
      required: ["field", "direction"],
    },
  },
  {
    name: "propose_video_edit",
    description:
      "PROPOSE (do not execute) a video edit. Returns a proposal the human must confirm before any render. " +
      "Operations: trim (keep start..end), cut (remove one section), audio (mute/remove/replace), " +
      "tighten (auto-remove dead air / long pauses — dramatic pauses are kept), " +
      "color (exposure/colour correction), zoom (Ken Burns zoom_in/zoom_out, or a punch_in for emphasis).",
    input_schema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["trim", "cut", "audio", "tighten", "color", "zoom"] },
        start: { type: "number", description: "trim: new start (s)" },
        end: { type: "number", description: "trim: new end (s)" },
        cut_start: { type: "number", description: "cut: start of the section to REMOVE (s)" },
        cut_end: { type: "number", description: "cut: end of the section to REMOVE (s)" },
        audio_action: { type: "string", enum: ["mute", "remove", "replace"], description: "audio: what to do (replace needs a file the human uploads in the manual editor)" },
        color_style: { type: "string", enum: ["auto", "warm", "cool", "punch", "flat"], description: "color: grading preset (auto = subtle exposure/colour correct)" },
        zoom_type: { type: "string", enum: ["zoom_in", "zoom_out", "punch_in"], description: "zoom: kind of move" },
        zoom_start: { type: "number", description: "zoom: start (s) on the clip timeline" },
        zoom_end: { type: "number", description: "zoom: end (s) on the clip timeline" },
        zoom_amount: { type: "number", description: "zoom: strength as a fraction, e.g. 0.15 = 15% (default 0.15)" },
        reason: { type: "string", description: "why this edit, in plain language" },
      },
      required: ["operation", "reason"],
    },
  },
];

async function regenerateCopy(field: string, direction: string, ctx: ClipEditContext): Promise<string> {
  const current =
    field === "hook" ? ctx.hook : field === "caption" ? ctx.caption : ctx.hashtags.map((h) => `#${h}`).join(" ");
  const instruction =
    field === "hashtags"
      ? `Return ONLY a space-separated list of 3-6 hashtags (no other text). Current: ${current}. Change: ${direction}.`
      : `Return ONLY the new ${field} text (no quotes, no explanation). Current ${field}: "${current}". Change: ${direction}. Keep Marco's voice: short, direct, first person, San Antonio specific, no corporate filler.`;
  const res = await claudeContent.messages.create({
    model: CONTENT_MODELS.FAST,
    max_tokens: 300,
    system: "You rewrite short-form real-estate social copy for Marco Puga. Output only the requested text, nothing else.",
    messages: [{ role: "user", content: instruction }],
  });
  return res.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}

/**
 * Run one turn of the clip-edit chat. Returns the agent's reply plus, if it
 * proposed a video edit, the structured proposal for the UI to confirm.
 */
export async function runClipEditChat(input: {
  message: string;
  history?: CmBrainChatMessage[];
  context: ClipEditContext;
}): Promise<{ reply: string; proposal: ClipEditProposal | null; copyUpdated: null | { field: string; value: string } }> {
  const ctx = input.context;
  let proposal: ClipEditProposal | null = null;
  let copyUpdated: { field: string; value: string } | null = null;

  const system =
    CLIP_EDIT_SYSTEM +
    "\n\nCURRENT CLIP CONTEXT:\n" +
    JSON.stringify(
      {
        hook: ctx.hook,
        caption: ctx.caption,
        hashtags: ctx.hashtags,
        score: ctx.score,
        duration_seconds: ctx.durationSeconds,
        captions_editable: ctx.captionsEditable,
        caption_lines: ctx.captions,
      },
      null,
      2,
    );

  const reply = await claudeChatWithTools({
    system,
    userMessage: input.message,
    history: input.history,
    tools: TOOLS,
    model: CONTENT_MODELS.QUALITY, // Sonnet — intent accuracy matters more than speed
    maxRounds: 6,
    onToolCall: async (name, args) => {
      if (name === "get_clip_context") {
        return {
          hook: ctx.hook,
          caption: ctx.caption,
          hashtags: ctx.hashtags,
          score: ctx.score,
          duration_seconds: ctx.durationSeconds,
          captions_editable: ctx.captionsEditable,
          caption_lines: ctx.captions,
          has_previous_version: ctx.hasPreviousVersion,
        };
      }
      if (name === "update_clip_copy") {
        const field = String(args.field || "");
        const direction = String(args.direction || "");
        if (!["hook", "caption", "hashtags"].includes(field)) return { error: "field must be hook, caption, or hashtags" };
        try {
          const value = await regenerateCopy(field, direction, ctx);
          if (!value) return { error: "Could not generate new copy" };
          if (field === "hashtags") {
            const tags = value.split(/\s+/).map((t) => t.replace(/^#/, "")).filter(Boolean);
            updateContentVideo(ctx.clipId, { hashtags: tags });
            copyUpdated = { field, value: tags.map((t) => `#${t}`).join(" ") };
          } else {
            updateContentVideo(ctx.clipId, { [field]: value } as never);
            copyUpdated = { field, value };
          }
          return { updated: true, field, new_value: copyUpdated.value };
        } catch (err) {
          logContentAiFailure("clip-edit copy regen", err);
          return { error: "Copy generation failed — try again." };
        }
      }
      if (name === "propose_video_edit") {
        const op = String(args.operation || "");
        const reason = String(args.reason || "");
        if (op === "trim") {
          const s = Number(args.start);
          const e = Number(args.end);
          if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return { error: "trim needs numeric start < end" };
          proposal = { summary: `Trim the clip to ${fmt(s)}–${fmt(e)} (${reason}), then re-render.`, spec: { trim: { start: s, end: e } } };
        } else if (op === "cut") {
          const cs = Number(args.cut_start);
          const ce = Number(args.cut_end);
          if (!Number.isFinite(cs) || !Number.isFinite(ce) || ce <= cs) return { error: "cut needs numeric cut_start < cut_end" };
          proposal = { summary: `Remove the section ${fmt(cs)}–${fmt(ce)} (${reason}) and splice the rest together, then re-render.`, spec: { cuts: [[cs, ce]] } };
        } else if (op === "audio") {
          const act = String(args.audio_action || "");
          if (!["mute", "remove", "replace"].includes(act)) return { error: "audio_action must be mute, remove, or replace" };
          if (act === "replace") {
            return { proposed: false, note: "Audio replace needs a file — tell Marco to use the ✂ Edit Clip → Replace… control to upload the track." };
          }
          proposal = { summary: `${act === "mute" ? "Mute" : "Remove"} the clip's audio (${reason}), then re-render.`, spec: { audio: act as "mute" | "remove" } };
        } else if (op === "tighten") {
          proposal = {
            summary: `Auto-remove dead air / long pauses (${reason}), re-sync the captions to the tighter timeline, then re-render. Intentional dramatic pauses are kept.`,
            spec: { autoTighten: true },
          };
        } else if (op === "color") {
          const style = String(args.color_style || "auto");
          if (!["auto", "warm", "cool", "punch", "flat"].includes(style)) return { error: "color_style must be auto, warm, cool, punch, or flat" };
          proposal = {
            summary: `Apply "${style}" colour/exposure correction (${reason}), then re-render.`,
            spec: { color: style as "auto" | "warm" | "cool" | "punch" | "flat" },
          };
        } else if (op === "zoom") {
          const zt = String(args.zoom_type || "");
          if (!["zoom_in", "zoom_out", "punch_in"].includes(zt)) return { error: "zoom_type must be zoom_in, zoom_out, or punch_in" };
          const zs = Number(args.zoom_start);
          const ze = Number(args.zoom_end);
          if (!Number.isFinite(zs) || !Number.isFinite(ze) || ze <= zs) return { error: "zoom needs numeric zoom_start < zoom_end" };
          const amt = Number(args.zoom_amount);
          const amount = Number.isFinite(amt) && amt > 0 ? amt : 0.15;
          const label = zt === "punch_in" ? "punch-in" : zt === "zoom_out" ? "zoom-out" : "zoom-in";
          proposal = {
            summary: `Add a ${label} (${Math.round(amount * 100)}%) from ${fmt(zs)} to ${fmt(ze)} (${reason}), then re-render.`,
            spec: { effects: [{ type: zt as "zoom_in" | "zoom_out" | "punch_in", start: zs, end: ze, amount }] },
          };
        } else {
          return { error: "operation must be trim, cut, audio, tighten, color, or zoom" };
        }
        return { proposed: true, summary: proposal.summary };
      }
      return { error: `Unknown tool: ${name}` };
    },
  });

  return { reply, proposal, copyUpdated };
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
