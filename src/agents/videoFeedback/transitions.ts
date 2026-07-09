/**
 * CapCut transition reference for Marco's real-estate TikTok editing. Powers the
 * /api/content/transitions endpoint (guided editor + AI-feedback transition tips).
 */
export interface Transition {
  id: string;
  name: string; // exact CapCut name
  category: string; // 'basic' | 'energy' | 'cinematic' | 'creative'
  bestFor: string[]; // content types this works for
  avoid: string[]; // when NOT to use
  timing: string; // recommended duration
  howTo: string; // CapCut implementation steps
  realEstatePerfect: boolean; // specially good for Marco's content
}

export const TRANSITIONS: Transition[] = [
  {
    id: "smash_cut",
    name: "Cut (Hard Cut)",
    category: "basic",
    bestFor: ["hooks", "property reveals", "before/after", "fast pacing"],
    avoid: ["emotional moments", "testimonials"],
    timing: "0 frames — instant",
    howTo: "Default cut in CapCut — no transition applied. Just trim clips together.",
    realEstatePerfect: true,
  },
  {
    id: "zoom_punch",
    name: "Zoom In",
    category: "energy",
    bestFor: ["hooks", "emphasizing a price drop", "highlighting a feature", "text reveals"],
    avoid: ["slow walkthroughs", "calm explainers"],
    timing: "0.2-0.3s",
    howTo: "CapCut → Transitions → Basic → Zoom In. Set duration to 0.2s.",
    realEstatePerfect: true,
  },
  {
    id: "whip_pan",
    name: "Whip (Speed Blur)",
    category: "energy",
    bestFor: ["moving between rooms", "multiple property cuts", "high-energy hooks"],
    avoid: ["luxury/high-end content where elegance matters"],
    timing: "0.3-0.5s",
    howTo: "CapCut → Transitions → Trending → Whip. Pair with a swipe sound effect.",
    realEstatePerfect: true,
  },
  {
    id: "fade_black",
    name: "Fade to Black",
    category: "cinematic",
    bestFor: ["ending a video", "separating major sections", "emotional moments"],
    avoid: ["hooks", "mid-video energy spikes"],
    timing: "0.5-1.0s",
    howTo: "CapCut → Transitions → Basic → Fade → Fade to Black.",
    realEstatePerfect: false,
  },
  {
    id: "match_cut",
    name: "Match Cut (Manual)",
    category: "cinematic",
    bestFor: ["before/after same room", "old home → new home", "building anticipation"],
    avoid: ["quick-paced content"],
    timing: "No transition — achieved through editing similar shapes/compositions together",
    howTo:
      "Cut from shot A to shot B where a visual element aligns (doorframe to doorframe, window to window). No CapCut transition needed — it's the edit itself.",
    realEstatePerfect: true,
  },
  {
    id: "push",
    name: "Push",
    category: "basic",
    bestFor: ["moving forward into a property", "scene changes", "revealing next room"],
    avoid: ["hooks — too slow for first seconds"],
    timing: "0.3-0.5s",
    howTo: 'CapCut → Transitions → Basic → Push. Use "Push Right" or "Push In" for forward movement.',
    realEstatePerfect: true,
  },
  {
    id: "glitch",
    name: "Glitch",
    category: "creative",
    bestFor: ["price reveals", "shocking stats", '"wait for it" moments'],
    avoid: ["luxury properties where polish matters"],
    timing: "0.2-0.3s",
    howTo: "CapCut → Transitions → Trending → Glitch.",
    realEstatePerfect: false,
  },
  {
    id: "spin",
    name: "Spin / Rotate",
    category: "creative",
    bestFor: ["TikTok trend-following content", "hook transitions", "high energy"],
    avoid: ["serious buyer education content"],
    timing: "0.3s",
    howTo: "CapCut → Transitions → Basic → Rotate.",
    realEstatePerfect: false,
  },
  {
    id: "dissolve",
    name: "Dissolve (Cross Fade)",
    category: "cinematic",
    bestFor: ["time lapses", "soft property walkthrough", "client testimonials"],
    avoid: ["fast-paced hooks", "energy content"],
    timing: "0.5-1.0s",
    howTo: "CapCut → Transitions → Basic → Dissolve.",
    realEstatePerfect: false,
  },
  {
    id: "flash",
    name: "Flash White",
    category: "energy",
    bestFor: ["property reveal moments", "dramatic price drops", "highlight reels"],
    avoid: ["calm content", "educational walkthroughs"],
    timing: "0.1-0.2s — fast",
    howTo: "CapCut → Transitions → Flash → Flash White. Keep it short.",
    realEstatePerfect: true,
  },
];

export type ContentType = "hook" | "walkthrough" | "reveal" | "educational" | "testimonial";

export function getTransitionsForContentType(contentType: ContentType): Transition[] {
  const typeMap: Record<string, string[]> = {
    hook: ["smash_cut", "zoom_punch", "whip_pan", "flash"],
    walkthrough: ["push", "dissolve", "match_cut"],
    reveal: ["flash", "glitch", "zoom_punch", "match_cut"],
    educational: ["push", "smash_cut", "dissolve"],
    testimonial: ["dissolve", "fade_black", "smash_cut"],
  };
  const ids = typeMap[contentType] || ["smash_cut", "push"];
  return TRANSITIONS.filter((t) => ids.includes(t.id));
}

export function getTopTransitionsForRealEstate(): Transition[] {
  return TRANSITIONS.filter((t) => t.realEstatePerfect);
}
