import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    deps: {
      optimizer: {
        web: {
          include: ["rrweb", "@rrweb/packer", "@rrweb/types"],
        },
      },
    },
  },
});
