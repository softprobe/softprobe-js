import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SoftprobeClient } from "@softprobe/tracing";
import { SoftprobeSessionTracer } from "@softprobe/opencode-plugin";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const outPath =
  process.env.OPENCODE_PLUGIN_IDS_PATH ??
  join(root, "examples", ".opencode-plugin-ids.json");
const parentSessionId =
  process.env.OPENCODE_PLUGIN_SESSION_ID ?? `sess-opencode-plugin-${Date.now()}`;
const childSessionId =
  process.env.OPENCODE_PLUGIN_CHILD_SESSION_ID ?? `${parentSessionId}-child`;
const baseUrl = process.env.SOFTPROBE_BASE_URL ?? "http://127.0.0.1:8090";
const publicKey = process.env.SOFTPROBE_PUBLIC_KEY ?? "e2e-token";
const otlpEndpoint =
  process.env.SOFTPROBE_OTLP_ENDPOINT ?? `${baseUrl}/v1/traces`;

async function main(): Promise<void> {
  const client = new SoftprobeClient({
    publicKey,
    baseUrl,
    otlpEndpoint,
    serviceName: "opencode",
    serviceVersion: "0.1.0",
    environment: "e2e",
  });
  const tracer = new SoftprobeSessionTracer(client, { userId: "opencode-e2e" });

  const t0 = Date.now();
  const toolCallId = "call_bash_e2e";
  const taskCallId = "call_task_verify_e2e";

  tracer.registerSessionInfo(parentSessionId, null);
  tracer.traceUserMessage({
    sessionID: parentSessionId,
    messageID: "msg-user-e2e",
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-4.1-mini" },
    parts: [{ type: "text", text: "verify the answer with a subagent" }],
  });

  tracer.startActiveGenerationStep({
    sessionID: parentSessionId,
    agent: "build",
    model: { providerID: "openai", id: "gpt-4.1-mini" },
    started: t0,
  });

  tracer.traceToolStart({
    sessionID: parentSessionId,
    callID: toolCallId,
    tool: "bash",
    args: { command: "ls" },
  });
  tracer.traceToolEnd({
    sessionID: parentSessionId,
    callID: toolCallId,
    tool: "bash",
    args: { command: "ls" },
    title: "ls",
    output: "README.md",
  });

  // Nested OpenCode task → child session (product session must stay parent).
  tracer.traceToolStart({
    sessionID: parentSessionId,
    callID: taskCallId,
    tool: "task",
    args: { prompt: "reply OK", subagent_type: "verify" },
  });
  tracer.traceToolPart({
    id: `part-${taskCallId}`,
    type: "tool",
    sessionID: parentSessionId,
    messageID: "msg-asst-e2e",
    callID: taskCallId,
    tool: "task",
    state: {
      status: "running",
      input: { prompt: "reply OK", subagent_type: "verify" },
      metadata: {
        sessionId: childSessionId,
        parentSessionId: parentSessionId,
      },
      time: { start: t0 + 500 },
    },
  });

  await tracer.ensureSessionClassified(childSessionId, {
    agent: "verify",
    promptText: "reply OK",
  });
  tracer.traceUserMessage({
    sessionID: childSessionId,
    messageID: "msg-user-child",
    agent: "verify",
    parts: [{ type: "text", text: "reply OK" }],
  });
  tracer.startActiveGenerationStep({
    sessionID: childSessionId,
    agent: "verify",
    model: { providerID: "openai", id: "gpt-4.1-mini" },
    started: t0 + 600,
  });
  tracer.traceGeneration({
    sessionID: childSessionId,
    messageID: "msg-asst-child",
    parentID: "msg-user-child",
    modelID: "gpt-4.1-mini",
    providerID: "openai",
    mode: "verify",
    created: t0 + 600,
    completed: t0 + 900,
    finish: "stop",
    cost: 0.001,
    tokens: {
      input: 4,
      output: 1,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  });
  tracer.traceToolEnd({
    sessionID: parentSessionId,
    callID: taskCallId,
    tool: "task",
    args: { prompt: "reply OK", subagent_type: "verify" },
    title: "verify",
    output: `<task id="${childSessionId}" state="completed">\nOK\n</task>`,
  });

  tracer.rememberAssistantPart({
    id: "part-text",
    type: "text",
    messageID: "msg-asst-e2e",
    text: "verified",
  });
  tracer.rememberAssistantPart({
    id: toolCallId,
    type: "tool",
    messageID: "msg-asst-e2e",
    tool: "bash",
  });

  tracer.traceGeneration({
    sessionID: parentSessionId,
    messageID: "msg-asst-e2e",
    parentID: "msg-user-e2e",
    modelID: "gpt-4.1-mini",
    providerID: "openai",
    mode: "build",
    created: t0,
    completed: t0 + 1200,
    finish: "stop",
    cost: 0.002,
    tokens: {
      input: 12,
      output: 8,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  });

  tracer.finalizeSessionTracing();
  await client.forceFlush();
  await client.shutdown();

  const meta = {
    sessionId: parentSessionId,
    childSessionId,
    toolCallId,
    taskCallId,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(meta, null, 2));
  console.log(JSON.stringify(meta));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
