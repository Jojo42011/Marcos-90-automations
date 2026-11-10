import { build } from "esbuild";
await build({
  entryPoints: ["web/people/main.tsx"],
  bundle: true,
  outdir: "public/astryx",
  entryNames: "people",
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  minify: true,
  metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
}).then(async (r) => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile("public/astryx/meta.json", JSON.stringify(r.metafile));
});
