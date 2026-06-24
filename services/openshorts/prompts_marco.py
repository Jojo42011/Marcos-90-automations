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
4. 30-60 seconds total duration — sweet spot for TikTok completion rate
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
) -> str:
    pillar_instructions = {
        "education": "Prioritize moments where Marco explains a specific number, process step, or market insight clearly and concisely. Look for 'did you know', 'here's what that means', 'most buyers don't realize' type moments.",
        "listings": "Prioritize moments showcasing specific property features with prices. Look for price reveals, neighborhood comparisons, and moments Marco reacts to the property.",
        "brand": "Prioritize moments where Marco is confident, direct, and speaking from personal experience or a recent win. Look for storytelling moments, client results, and behind-the-scenes insights.",
        "mixed": "Balance across all three pillars. Prioritize the moments with the strongest hooks regardless of pillar.",
    }

    trend_section = (
        f"\n\nCURRENT TRENDING PATTERNS IN REAL ESTATE TIKTOK (factor these into your selection):\n{trend_brief}"
        if trend_brief
        else ""
    )

    return f"""
{MARCO_CONTEXT}

CONTENT PILLAR FOR THIS SESSION: {pillar.upper()}
{pillar_instructions.get(pillar, pillar_instructions["mixed"])}
{trend_section}

VIDEO TRANSCRIPT (total duration: {video_duration:.1f} seconds):
{transcript}

TASK: Identify exactly {target_clips} clips from this video that will perform best on TikTok for Marco's real estate content.

For each clip, return:
- start_time: seconds from beginning (float)
- end_time: seconds (float) — target 30-65 seconds per clip
- viral_score: 0-100 based on hook strength, specificity, and conversion potential
- hook_type: one of [data, personal_story, local, controversy, question, shock]
- hook_preview: the exact words in the first 3 seconds of the clip
- suggested_title: internal title for the clip (not for posting)
- suggested_caption: TikTok caption in Marco's voice (direct, first person, San Antonio specific, ends with CTA)
- pillar: which content pillar this clip maps to
- why_this_clip: one sentence explanation of why this moment will perform

Return as valid JSON array only. No markdown, no explanation outside the JSON.
Sort by viral_score descending (best clip first).

IMPORTANT:
- Never start a clip mid-sentence. Find the natural speech boundary.
- Minimum clip duration is 25 seconds. Maximum is 65 seconds.
- Every clip must open with a strong hook in the first 3 seconds.
- Prefer clips where Marco mentions specific prices, neighborhoods, or market data.
- Avoid clips where Marco says generic phrases like "reach out to me" without context.
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
