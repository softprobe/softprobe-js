# @softprobe/e2e

Full-stack end-to-end testing SDK that pairs [`e2e`](https://github.com/e2e-inc/e2e) browser automation and `.e2e/cache/` zero-LLM replay with deterministic W3C distributed-trace verification of outgoing backend HTTP calls across Softprobe Blackbox (`thelake` / Explorer) and Arex (`sp-backend`).

## Quick start

Configure `softprobeWeb` and `softprobeReporter` in `e2e.config.ts`:

```ts
import type { E2EConfig } from "e2e";
import { softprobeReporter, softprobeWeb } from "@softprobe/e2e";

export default {
  targets: [
    {
      name: "web",
      engine: softprobeWeb({
        endpoint: process.env.SOFTPROBE_URL,
        token: process.env.SOFTPROBE_TOKEN,
        workspaceId: process.env.SOFTPROBE_WORKSPACE_ID,
      }),
      app: {
        url: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000",
      },
    },
  ],
  reporters: ["list", softprobeReporter()],
} satisfies E2EConfig;
```

Assert both UI state and backend outgoing HTTP requests in `.e2e.ts` specs:

```ts
import { expect, test } from "@softprobe/e2e";

test("sends workspace invite email", async ({ app, agent, screen, trace }) => {
  await app.open("/");
  await agent.act("invite lc@softprobe.ai to the workspace");

  await expect(screen.getByText("lc@softprobe.ai")).toBeVisible();

  const emailCall = await trace.outboundHttp({
    triggeredBy: {
      method: "POST",
      path: "/api/workspaces/:workspaceId/invites",
    },
    method: "POST",
    url: /\/v1\/account\/[^/]+\/submit$/,
  });

  expect(emailCall.status).toBe(200);
});
```

## Playwright fixture (`@softprobe/e2e/playwright`)

Import `test` and `expect` from `@softprobe/e2e/playwright` to use the `trace` fixture inside `@playwright/test` suites:

```ts
import { expect, test } from "@softprobe/e2e/playwright";

test("verifies backend outbound HTTP call", async ({ page, trace }) => {
  await page.goto("/invite");
  await page.getByLabel("Email address").fill("lc@softprobe.ai");
  await page.getByRole("button", { name: "Send invitation" }).click();

  const emailCall = await trace.outboundHttp({
    triggeredBy: { method: "POST", path: "/api/workspaces/:workspaceId/invites" },
    method: "POST",
    url: /\/v1\/account\/invite\/submit$/,
  });
  expect(emailCall.status).toBe(200);
});
```
