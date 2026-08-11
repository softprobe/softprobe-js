import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    deps: {
      optimizer: {
        web: {
          include: ["rrweb", "@rrweb/types"],
        },
      },
    },
  },
  resolve: {
    alias: {
      // rrweb's "main" is CJS with "type":"module" — use the ESM build in tests.
      rrweb: "rrweb/es/rrweb/packages/rrweb/src/entries/all.js",
    },
  },
});
