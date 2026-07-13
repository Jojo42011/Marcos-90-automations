"""
Marco Puga Realty — OpenShorts custom prompts
Overrides default viral moment detection with real estate content strategy
"""

MARCO_CONTEXT = """
You are analyzing a video for @puga.realtor — Marco Puga, a real estate agent in San Antonio, Texas.
Marco's content benchmark is 6,006 views per video. Content below benchmark gets cut.
His buyer engine: 246,000 views = 1 closing = approximately $667,000 in revenue.

THREE CONTENT PILLARS (in order of conversion power):
- BRAND: Marco on camera, testimonials, wins, personal moments. Converts hardest. Always prioritize.
- EDUCATION: Market updates, rate explainers, neighborhood guides, buying process. Drives saves.
- LISTINGS: Home tours, just listed, just sold. Broadest reach, lowest DM conversion.

MARCO'S AUDIENCE: First-time buyers aged 25-40 in San Antonio. Confused about the process,
anxious about rates, looking for someone trustworthy. Content that speaks directly to their
specific fears and questions outperforms generic real estate content by 3-4x.

SAN ANTONIO SPECIFICS: Stone Oak, Canyon Lake, New Braunfels, Alamo Heights, 78258, 78259, 78209.
Hyperlocal content with specific neighborhood names and exact prices converts best.

WHAT MAKES A GREAT CLIP FOR MARCO:
1. Opens with a specific number, neighborhood name, or surprising claim in the first 3 seconds
2. Marco is direct, confident, and speaking from personal experience
3. Contains at least one specific data point (price, rate, percentage, timeline)
4. 35-65 seconds total duration — sweet spot for TikTok completion rate
5. Ends with implicit or explicit curiosity gap that drives DM ("DM me for the full breakdown")

HOOK TYPES THAT OUTPERFORM IN REAL ESTATE (find clips that match these):
- Data Hook: leads with a specific dollar amount, percentage, or market stat
- Personal Story: "Last week my client..." or "I just closed a deal where..."
- Local Hook: opens with a San Antonio neighborhood name and specific claim
- Controversy: "Stop waiting for rates to drop" or "Most agents won't tell you this"
- Question Hook: "Did you know you can buy in [neighborhood] for under $[X]?"
"""


def get_viral_moment_prompt(
    transcript: str,
    video_duration: float,
    pillar: str = "brand",
    trend_brief: str = "",
    target_clips: int = 7,
    prosody_brief: str = "",
    quality_floor: int = 70,
    has_frames: bool = False,
    user_context: str = "",
    script_text: str = "",
    style_guide: str = "",
) -> str:
    pillar_instructions = {
        "education": "Prioritize moments where Marco explains a specific number, process step, or market insight clearly and concisely. Look for 'did you know', 'here's what that means', 'most buyers don't realize' type moments.",
        "listings": "Prioritize moments showcasing specific property features with prices. Look for price reveals, neighborhood comparisons, and moments Marco reacts to the property.",
        "brand": "Prioritize moments where Marco is confident, direct, and speaking from personal experience or a recent win. Look for storytelling moments, client results, and behind-the-scenes insights.",
        "mixed": "Balance across all three pillars. Prioritize the moments with the strongest hooks regardless of pillar.",
    }

    # Human direction outranks every algorithmic signal (trends, prosody, frames):
    # the person who filmed the video knows what's in it better than any model.
    human_direction = ""
    if user_context or script_text:
        human_direction = "\n\nHUMAN DIRECTION — PRIORITIZE THIS ABOVE ALL OTHER SIGNALS:\n"
        if user_context:
            human_direction += (
                f'The person uploading this video said: "{user_context}"\n'
                "Find and prioritize the moments they described. Their knowledge of the "
                "content overrides algorithmic judgment — if they point at a moment, clip it "
                "(as long as it meets the minimum quality bar).\n"
            )
        if script_text:
            human_direction += (
                f"\nSCRIPT PROVIDED FOR THIS VIDEO:\n{script_text[:3000]}\n"
                "Use the script to identify the most impactful lines, then find those exact "
                "moments in the transcript below.\n"
            )

    # Marco's own accumulated style profile — built from reference videos he
    # uploaded specifically to teach the clipper his pacing/hook/editing habits.
    # This is a standing preference, weaker than per-batch human_direction (which
    # is about THIS footage) but stronger than generic trend data.
    style_section = (
        f"\n\nMARCO'S STYLE GUIDE (learned from videos he uploaded as examples of "
        f"how he films and how he wants clips cut — apply this as a standing "
        f"preference for every clip you select from THIS video):\n{style_guide}"
        if style_guide
        else ""
    )

    trend_section = (
        f"\n\nCURRENT TRENDING PATTERNS IN REAL ESTATE TIKTOK (factor these into your selection):\n{trend_brief}"
        if trend_brief
        else ""
    )

    # When video frames accompany this prompt, tell the model to reason about what
    # it SEES, not only the words — and to report visual problems the transcript
    # can't reveal. The frames are sampled at scene changes + the flagged moments.
    frames_section = (
        "\n\nVIDEO FRAMES ATTACHED: A set of still frames from this video is provided as images "
        "(sampled at scene changes and at the flagged delivery moments above). Study them. Using BOTH "
        "the transcript and these frames, judge each candidate clip on:\n"
        "- Visual quality of the shot: framing, camera movement/shake, clarity, lighting.\n"
        "- Visible bloopers the transcript can't show: an awkward expression, Marco looking off-camera, "
        "bad framing, someone/something entering the frame unexpectedly, a cluttered or unflattering shot.\n"
        "- Whether the visual matches the claimed content — e.g. a 'walkthrough' moment should actually "
        "show movement through a space; a 'reveal' should show the feature being revealed.\n"
        "Prefer clips whose VISUALS are strong, and penalize (or avoid) clips with visual problems even if "
        "the words are good."
        if has_frames
        else ""
    )

    visual_field_line = (
        '\n- visual_issues_detected: array of short strings naming any visual problems you SEE in this '
        "clip's frames (framing, shake, blur, awkward expression, unexpected person/object, visual/"
        'transcript mismatch). Use an empty array [] if the visuals look clean.'
        if has_frames
        else ""
    )

    return f"""
{MARCO_CONTEXT}

CONTENT PILLAR FOR THIS SESSION: {pillar.upper()}
{pillar_instructions.get(pillar, pillar_instructions["mixed"])}
{human_direction}{style_section}{trend_section}
{prosody_brief}{frames_section}
VIDEO TRANSCRIPT (total duration: {video_duration:.1f} seconds):
{transcript}

TASK: Identify the BEST clips from this video for Marco's real estate TikTok —
UP TO {target_clips}, but only the ones that are genuinely strong. Quality over
volume: it is far better to return 2 excellent clips than {target_clips} mediocre
ones. Do NOT pad the list to reach {target_clips}. Return ONLY clips you would
score {quality_floor} or higher on the viral_score scale below. If only one moment
in the whole video clears that bar, return exactly one clip. If none do, return
the single strongest moment anyway (never an empty array).

For each clip, return:
- start_time: seconds from beginning (float)
- end_time: seconds (float) — target 35-65 seconds per clip
- scores: an object with four 0-100 dimensions plus their weighted total:
    "hook_strength": how hard the first 3 seconds stop the scroll
    "emotional_flow": does the clip build and PAY OFF what the hook opened
    "perceived_value": does a viewer walk away knowing something concrete
    "trend_alignment": fit with the current trending patterns above
    "total": round(0.35*hook_strength + 0.25*emotional_flow + 0.25*perceived_value + 0.15*trend_alignment)
- viral_score: same number as scores.total (kept for compatibility)
- hook_type: one of [data, personal_story, local, controversy, question, shock]
- hook_preview: the exact words in the first 3 seconds of the clip
- suggested_title: internal title for the clip (not for posting)
- suggested_caption: TikTok caption in Marco's voice (direct, first person, San Antonio specific, ends with CTA)
- pillar: which content pillar this clip maps to
- why_this_clip: MANDATORY — one sentence explaining why this specific segment was chosen{visual_field_line}

Return as valid JSON array only. No markdown, no explanation outside the JSON.
Sort by scores.total descending (best clip first).

SEGMENT SELECTION RULES — NON-NEGOTIABLE:
1. Every clip MUST begin at the start of a sentence and end at the end of a
   sentence. A clip that starts mid-thought is a failed clip regardless of
   content quality. Use the pause timestamps in the vocal-delivery signals
   above to find real sentence boundaries.
2. Every clip must be SELF-CONTAINED: a viewer with zero context must
   understand it completely.
3. Every clip must have a hook in its first 3 seconds — a question, a
   surprising claim, a specific number, or a bold statement.
4. Every clip must have a payoff — it resolves what the hook opened. A hook
   with no payoff scores 0 on emotional_flow.
5. Minimum clip duration is 35 seconds. Maximum is 65 seconds.
6. Prefer clips where Marco mentions specific prices, neighborhoods, or market data.
7. Avoid clips where Marco says generic phrases like "reach out to me" without context.
8. QUALITY GATE: only include a clip if scores.total is {quality_floor}+. If you
   cannot find {target_clips} segments meeting rules 1-4, return FEWER clips —
   never pad with weak segments. The "why_this_clip" field is mandatory for every clip.
"""


def get_style_analysis_prompt(
    transcript: str,
    kind: str,
    video_duration: float,
    has_frames: bool = False,
) -> str:
    """Prompt for analyzing ONE reference video Marco uploaded to teach the
    clipper his style — NOT a clip-selection prompt. Returns a short reusable
    brief (plain text, not JSON) that gets folded into MARCO'S STYLE GUIDE and
    injected into every future clip-selection prompt.

    kind: "clip" — an already-published, well-performing FINAL clip. Analyze
        the finished edit: pacing, hook technique, cut rhythm, tone, structure.
    kind: "raw" — unedited source footage. Analyze Marco's DELIVERY: energy,
        pacing of speech, natural pause patterns, how he sets up a point —
        habits an editor should preserve when choosing/cutting clips.
    """
    if kind == "raw":
        focus = (
            "This is RAW, UNEDITED footage of Marco — there is no editing to study here, "
            "only his natural delivery. Focus on:\n"
            "- His speech pacing and energy: where does he speed up, slow down, get more "
            "animated or more serious?\n"
            "- How he builds to a point: does he lead with the number, or build up to it? "
            "Does he ask a question before answering it?\n"
            "- Natural pause patterns: where does he pause for effect vs. where does he "
            "just trail off or lose his train of thought?\n"
            "- Verbal habits: phrases he repeats, how he opens a thought, how he signals "
            "he's about to say something important.\n"
        )
    else:
        focus = (
            "This is an ALREADY-PUBLISHED, well-performing clip — study the FINISHED EDIT "
            "as an example of what a good clip from Marco looks like. Focus on:\n"
            "- Pacing: how long does the hook run before the payoff? How quickly do beats move?\n"
            "- Hook technique: exactly how does the first 3 seconds grab attention?\n"
            "- Structure: what's the shape of the clip (hook → build → payoff → CTA, or "
            "something else)?\n"
            "- Tone and energy throughout — does it stay constant or shift?\n"
        )

    frames_note = (
        "\nFrames from this video are attached — use them alongside the transcript to judge "
        "pacing and visual energy, not just the words.\n"
        if has_frames
        else ""
    )

    return f"""
{MARCO_CONTEXT}

You are studying ONE reference video ({video_duration:.0f}s long) that Marco uploaded
specifically so you can learn his style — NOT to select clips from it.

{focus}{frames_note}
TRANSCRIPT:
{transcript}

TASK: Write a SHORT, REUSABLE style brief (4-8 sentences, plain prose, no JSON, no
markdown headers) that captures what makes this example distinctive. Write it as
standing guidance for a future clip-selection pass — e.g. "Marco favors an
abrupt, data-first hook with no warmup" or "Natural energy peaks come ~8-10s into
a thought, right before the specific number — clips should open close to there."
Be concrete and specific to THIS video, not generic real-estate advice. If the
footage is too short, too garbled, or shows nothing distinctive, say so briefly
in one sentence instead of inventing detail.
"""


def get_caption_prompt(transcript_segment: str, pillar: str, hook_type: str) -> str:
    return f"""
Write a TikTok caption for Marco Puga (@puga.realtor), a San Antonio real estate agent.

Content: {transcript_segment[:500]}
Pillar: {pillar}
Hook type: {hook_type}

Marco's voice rules:
- Short sentences. Direct. First person.
- Contractions always (you're not you are, I'm not I am)
- No corporate speak. No buzzwords.
- San Antonio specific when possible
- Real numbers when mentioned
- Max one exclamation point
- End with a CTA: "DM me", "Follow for more SA updates", or "Comment below"

Return ONLY the caption text. No hashtags. Max 150 characters. No explanation.
"""
