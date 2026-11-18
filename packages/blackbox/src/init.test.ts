import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInit } from "./init.js";
import type { ExplorerUrl, FetchLike, IngestionKey } from "./types.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "blackbox-init-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runInit", () => {
  it("writes --ingestion-key to .env without calling OAuth or Explorer", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "@acme/api" }), "utf8");
    await writeFile(path.join(dir, ".env"), "PORT=8080\n", "utf8");

    const fetchMock = vi.fn<FetchLike>();
    const result = await runInit(
      {
        cwd: dir,
        explorerUrl: "https://explorer.softprobe.ai" as ExplorerUrl,
        ingestionKey: "spk_direct_key" as IngestionKey,
        envFile: ".env",
        openBrowser: false,
      },
      { fetch: fetchMock, log: () => {} },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      projectName: "api",
      explorerUrl: "https://explorer.softprobe.ai",
      envPath: path.join(dir, ".env"),
      ingestionKey: "spk_direct_key",
      source: "flag",
      envAction: "updated",
    });
    await expect(readFile(path.join(dir, ".env"), "utf8")).resolves.toBe(
      "PORT=8080\nSOFTPROBE_INGESTION_KEY=spk_direct_key\n",
    );
  });

  it("runs OAuth PKCE flow and provisions an ingestion key via /mcp", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "travel-ota" }), "utf8");

    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn<FetchLike>(async (input, init) => {
      const url = String(input);
      if (url === "https://explorer-staging.softprobe.ai/oauth/register") {
        return new Response(JSON.stringify({ client_id: "client_123" }), { status: 201 });
      }
      if (url === "https://explorer-staging.softprobe.ai/oauth/token") {
        const body = String(init?.body ?? "");
        expect(body).toContain("grant_type=authorization_code");
        expect(body).toContain("code=auth_code_xyz");
        return new Response(JSON.stringify({ access_token: "mcp_jwt_token" }), { status: 200 });
      }
      if (url === "https://explorer-staging.softprobe.ai/mcp") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mcp_jwt_token");
        const rpc = JSON.parse(String(init?.body)) as {
          id: string;
          params: { name: string; arguments: Record<string, unknown> };
        };
        if (rpc.params.name === "create_agent") {
          expect(rpc.params.arguments).toEqual({ name: "travel-ota" });
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ code: "agent_id_exists", agent_id: "travel-ota" }),
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }
        if (rpc.params.name === "get_ingestion_key") {
          expect(rpc.params.arguments).toEqual({ agent_id: "travel-ota" });
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                isError: false,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ agentId: "travel-ota", apiKey: "spk_from_oauth" }),
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const openUrl = vi.fn(async (authUrl: string) => {
      const parsed = new URL(authUrl);
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      const state = parsed.searchParams.get("state")!;
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("code", "auth_code_xyz");
      callbackUrl.searchParams.set("state", state);
      const cbRes = await realFetch(callbackUrl.toString());
      expect(cbRes.status).toBe(200);
      return true;
    });

    const result = await runInit(
      {
        cwd: dir,
        explorerUrl: "https://explorer-staging.softprobe.ai" as ExplorerUrl,
        envFile: ".env",
        openBrowser: true,
      },
      { fetch: fetchMock, openUrl, log: () => {} },
    );

    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      projectName: "travel-ota",
      explorerUrl: "https://explorer-staging.softprobe.ai",
      envPath: path.join(dir, ".env"),
      ingestionKey: "spk_from_oauth",
      source: "oauth",
      envAction: "created",
    });
    await expect(readFile(path.join(dir, ".env"), "utf8")).resolves.toBe(
      "SOFTPROBE_INGESTION_KEY=spk_from_oauth\n",
    );
  });
});
