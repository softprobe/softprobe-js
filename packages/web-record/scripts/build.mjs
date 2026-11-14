import { readFileSync } from "node:fs";
import { build } from "esbuild";

const RRWEB_OLD_STYLE = 'old.setAttribute("style", m.oldValue);';
const RRWEB_NEW_STYLE = "old.style.cssText = m.oldValue;";

const rrwebCspStylePlugin = {
  name: "rrweb-csp-style-cssom",
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /[/\\]rrweb[/\\]dist[/\\]rrweb\.js$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      if (!source.includes(RRWEB_OLD_STYLE)) {
        throw new Error(`Expected "${RRWEB_OLD_STYLE}" in ${args.path}`);
      }
      return {
        contents: source.replace(RRWEB_OLD_STYLE, RRWEB_NEW_STYLE),
        loader: "js",
      };
    });
  },
};

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  sourcemap: true,
  outfile: "dist/index.js",
  external: ["@opentelemetry/*", "@softprobe/*", "ua-parser-js"],
  plugins: [rrwebCspStylePlugin],
});

await build({
  entryPoints: ["src/browser.ts"],
  bundle: true,
  format: "iife",
  globalName: "Softprobe",
  platform: "browser",
  target: "es2020",
  minify: true,
  outfile: "dist/browser.js",
  plugins: [rrwebCspStylePlugin],
});
