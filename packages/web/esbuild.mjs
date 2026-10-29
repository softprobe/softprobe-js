import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  outfile: "dist/softprobe-session.js",
  minify: true,
  legalComments: "none",
});
