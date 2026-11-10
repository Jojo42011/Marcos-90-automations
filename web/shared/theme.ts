import { defineTheme } from "@astryxdesign/core/theme";

import { neutralTheme } from "@astryxdesign/theme-neutral";

// All brand values live in the theme. Components keep Astryx's dimensions and states.

export function commandTheme(accent: string) {
  const valid = /^#[0-9a-f]{6}$/i.test(accent) ? accent : "#b91c1c";

  const rgb = valid
    .slice(1)
    .match(/../g)!
    .map((v) => parseInt(v, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));

  const foreground =
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 0.179
      ? "#101010"
      : "#ffffff";

  return defineTheme({
    name: "command-center",
    extends: neutralTheme,
    components: {
      "side-nav": { base: { width: "100%" } },
      "side-nav-item": {
        selected: {
          backgroundColor: "var(--color-accent-muted)",
          color: "var(--color-text-accent)",
        },
      },
    },
    tokens: {
      "--font-family-body": "Manrope, sans-serif",
      "--font-family-heading": "Manrope, sans-serif",

      "--color-accent": valid,
      "--color-on-accent": foreground,

      "--color-text-accent": [valid, `color-mix(in srgb, ${valid} 55%, white)`],

      "--color-icon-accent": [valid, `color-mix(in srgb, ${valid} 55%, white)`],

      "--color-accent-muted": [
        `color-mix(in srgb, ${valid} 8%, white)`,
        `color-mix(in srgb, ${valid} 16%, #181818)`,
      ],

      "--color-background-muted": ["#eef2f6", "#222222"],

      "--color-background-body": ["#f7f8fa", "#101010"],

      "--color-background-surface": ["#ffffff", "#181818"],

      "--color-background-card": ["#ffffff", "#181818"],

      "--color-text-primary": ["#202d3a", "#fafafa"],

      "--color-text-secondary": ["#536170", "#b8b8b8"],

      "--color-border": ["#e1e6eb", "#333333"],
    },
  });
}
