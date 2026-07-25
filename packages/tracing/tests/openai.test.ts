import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { SoftprobeClient } from "../src/client.js";
import { normalizeReadableSpans } from "../src/normalize.js";
import { observeOpenAI } from "../src/openai.js";
import type { ScoreRequest, ScoreTransport } from "../src/types.js";

class MemoryScoreTransport implements ScoreTransport {
  async createScore(_request: ScoreRequest): Promise<void> {}
}

function createClient() {
  const exporter = new InMemorySpanExporter();
  const client = new SoftprobeClient({
    publicKey: "test-key",
    baseUrl: "http://127.0.0.1:8091",
    otlpEndpoint: "http://127.0.0.1:8091/v1/traces",
    spanExporter: exporter,
    scoreTransport: new MemoryScoreTransport(),
    useSimpleProcessor: true,
  });
  return { client, exporter };
}

describe("observeOpenAI", () => {
  const clients: SoftprobeClient[] = [];

  afterEach(async () => {
    while (clients.length) {
      await clients.pop()!.shutdown();
    }
  });

  it("maps chat completion attributes", async () => {
    const { client, exporter } = createClient();
    clients.push(client);

    const fake = {
      baseURL: "https://api.openai.com/v1",
      chat: {
        completions: {
          create: async (args: Record<string, unknown>) => {
            expect(args.name).toBeUndefined();
            expect(args.sessionId).toBeUndefined();
            return {
              id: "chatcmpl-test",
              model: "gpt-4o-mini-2024-07-18",
              choices: [
                {
                  finish_reason: "stop",
                  message: { role: "assistant", content: "2" },
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 1,
                total_tokens: 11,
              },
            };
          },
        },
      },
    };

    const wrapped = observeOpenAI(fake, {
      softprobeClient: client,
      sessionId: "sess-openai-unit",
    });

    const response = await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "1+1=" }],
      temperature: 0,
      name: "math-gen",
      sessionId: "sess-openai-unit",
    });
    expect(response.choices[0].message.content).toBe("2");

    await client.forceFlush();
    const spans = normalizeReadableSpans(exporter.getFinishedSpans());
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe("math-gen");
    expect(span.observation_type).toBe("generation");
    expect(span.attributes["gen_ai.provider.name"]).toBe("openai");
    expect(span.attributes["gen_ai.request.model"]).toBe("gpt-4o-mini");
    expect(span.attributes["gen_ai.usage.total_tokens"]).toBe(11);
    expect(span.events.map((event) => event.name)).toEqual(
      expect.arrayContaining([
        "gen_ai.content.prompt",
        "gen_ai.content.completion",
      ]),
    );
  });

  it("records provider errors", async () => {
    const { client, exporter } = createClient();
    clients.push(client);
    const fake = {
      baseURL: "https://api.openai.com/v1",
      chat: {
        completions: {
          create: async () => {
            throw new Error("provider down");
          },
        },
      },
    };
    const wrapped = observeOpenAI(fake, { softprobeClient: client });
    await expect(
      wrapped.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("provider down");
    await client.forceFlush();
    const spans = normalizeReadableSpans(exporter.getFinishedSpans());
    expect(spans[0]?.status_code).toBe("ERROR");
  });

  it("records tools and tool_calls on the generation", async () => {
    const { client, exporter } = createClient();
    clients.push(client);
    const fake = {
      baseURL: "https://api.openai.com/v1",
      chat: {
        completions: {
          create: async (args: Record<string, unknown>) => {
            expect(args.tools).toBeDefined();
            return {
              id: "chatcmpl-tools",
              model: "gpt-4o-mini-2024-07-18",
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_lookup_1",
                        type: "function",
                        function: {
                          name: "lookup",
                          arguments: '{"q":"docs"}',
                        },
                      },
                    ],
                  },
                },
              ],
              usage: {
                prompt_tokens: 12,
                completion_tokens: 8,
                total_tokens: 20,
              },
            };
          },
        },
      },
    };
    const wrapped = observeOpenAI(fake, { softprobeClient: client });
    await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "find docs" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "lookup docs",
            parameters: { type: "object" },
          },
        },
      ],
      tool_choice: "auto",
      name: "tool-gen",
    });
    await client.forceFlush();
    const spans = normalizeReadableSpans(exporter.getFinishedSpans());
    const attrs = spans[0]!.attributes;
    expect(attrs["sp.tool.available_names"]).toEqual(["lookup"]);
    expect(attrs["sp.tool.call_names"]).toEqual(["lookup"]);
    expect(attrs["sp.tool.call_ids"]).toEqual(["call_lookup_1"]);
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["tool_calls"]);
  });
});
