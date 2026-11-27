import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "./args.js";
import { runHook } from "./hook.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "softprobe-hook-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("blackbox hook", () => {
  it("parses hook CLI arguments", () => {
    const parsed = parseCliArgs(["hook", "--agent", "cursor"]);
    expect(parsed).toEqual({ kind: "hook", options: { agent: "cursor" } });
  });

  it("skips telemetry cleanly when no ingestion key is configured", async () => {
    const home = await makeTempDir();
    const fetchMock = vi.fn();
    const result = await runHook(
      { agent: "cursor" },
      JSON.stringify({
        hook_event_name: "beforeSubmitPrompt",
        conversation_id: "conv-1",
        prompt: "hello",
      }),
      { fetch: fetchMock, env: {}, homeDir: home },
    );

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.exportedSpans).toBe(0);
    expect(result.stdout).toBe('{"continue":true,"permission":"allow"}');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pairs Cursor preToolUse/postToolUse and exports OTLP spans", async () => {
    const home = await makeTempDir();
    const cfgDir = path.join(home, ".config", "softprobe");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(
      path.join(cfgDir, "agent-telemetry.json"),
      JSON.stringify({
        ingestionKey: "spk_test_123",
        otlpEndpoint: "https://explorer.softprobe.ai/api/thelake/v1/traces",
      }),
    );

    const posted: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      posted.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response("{}", { status: 200 });
    });

    let tick = 1000n;
    const nowNs = () => {
      tick += 1_000_000n;
      return tick.toString();
    };

    await runHook(
      { agent: "auto" },
      JSON.stringify({
        hook_event_name: "beforeSubmitPrompt",
        conversation_id: "cursor-conv-42",
        prompt: "Fix the bug",
      }),
      { fetch: fetchMock, env: {}, homeDir: home, nowNs },
    );

    await runHook(
      { agent: "auto" },
      JSON.stringify({
        hook_event_name: "preToolUse",
        conversation_id: "cursor-conv-42",
        tool_name: "Shell",
        tool_use_id: "call-1",
        tool_input: { command: "npm test" },
      }),
      { fetch: fetchMock, env: {}, homeDir: home, nowNs },
    );

    const postRes = await runHook(
      { agent: "auto" },
      JSON.stringify({
        hook_event_name: "postToolUse",
        conversation_id: "cursor-conv-42",
        tool_name: "Shell",
        tool_use_id: "call-1",
        tool_output: "all tests passed",
      }),
      { fetch: fetchMock, env: {}, homeDir: home, nowNs },
    );

    expect(postRes.exportedSpans).toBe(1);
    expect(posted).toHaveLength(2);
    expect(posted[1]?.auth).toBe("Bearer spk_test_123");
    const toolSpan = (posted[1]?.body as any).resourceSpans[0].scopeSpans[0].spans[0];
    expect(toolSpan.name).toBe("cursor.tool.Shell");
    const attrs = Object.fromEntries(
      toolSpan.attributes.map((a: any) => [a.key, a.value.stringValue]),
    );
    expect(attrs["sp.session.id"]).toBe("cursor-conv-42");
    expect(attrs["sp.observation.type"]).toBe("tool");
    expect(attrs["gen_ai.tool.name"]).toBe("Shell");
    expect(attrs["sp.output"]).toBe("all tests passed");
  });

  it("handles Claude Code UserPromptSubmit and Stop with last_assistant_message", async () => {
    const home = await makeTempDir();
    const posted: any[] = [];
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    });

    const env = {
      SOFTPROBE_INGESTION_KEY: "spk_claude_456",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:8787/api/thelake/v1/traces",
    };

    await runHook(
      { agent: "auto" },
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "claude-sess-99",
        prompt: "Summarize README",
      }),
      { fetch: fetchMock, env, homeDir: home },
    );

    const stopRes = await runHook(
      { agent: "auto" },
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: "claude-sess-99",
        last_assistant_message: "Here is the summary.",
      }),
      { fetch: fetchMock, env, homeDir: home },
    );

    expect(stopRes.exportedSpans).toBe(2);
    const stopSpans = posted[1].resourceSpans[0].scopeSpans[0].spans;
    expect(stopSpans.map((s: any) => s.name)).toEqual([
      "claude-code.generation",
      "claude-code.turn",
    ]);
  });
});
