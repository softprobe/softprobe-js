/**
 * Softprobe LangChain example — docs best path (zero invoke callbacks edits).
 *
 *   export SOFTPROBE_PUBLIC_KEY=…
 *   export SOFTPROBE_BASE_URL=…
 *   export GEMINI_KEY=…   # or OPENAI_API_KEY
 *   npm start
 *
 * Softprobe reads configurable.thread_id — it does not mint session UUIDs.
 */
import "@softprobe/langchain";
import { tool } from "@langchain/core/tools";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { getHandler, instrument } from "@softprobe/langchain";
import { z } from "zod";

function requireModel() {
  const gemini =
    process.env.GEMINI_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (gemini) {
    if (!process.env.GOOGLE_API_KEY?.trim() && process.env.GEMINI_KEY?.trim()) {
      process.env.GOOGLE_API_KEY = process.env.GEMINI_KEY;
    }
    return {
      label: "google/gemini-2.5-flash",
      llm: new ChatGoogleGenerativeAI({ model: "gemini-2.5-flash" }),
    };
  }
  const openai = process.env.OPENAI_API_KEY?.trim();
  if (openai) {
    return {
      label: "openai/gpt-4o-mini",
      llm: new ChatOpenAI({ model: "gpt-4o-mini" }),
    };
  }
  throw new Error(
    "Set GEMINI_KEY (or GOOGLE_API_KEY) or OPENAI_API_KEY for this example",
  );
}

async function main() {
  const handler = getHandler() ?? instrument();
  const { label, llm } = requireModel();

  const multiply = tool(
    async ({ a, b }: { a: number; b: number }) => String(a * b),
    {
      name: "multiply",
      description: "Multiply two numbers",
      schema: z.object({
        a: z.number(),
        b: z.number(),
      }),
    },
  );

  const agent = createReactAgent({ llm, tools: [multiply] });
  const threadId =
    process.env.SOFTPROBE_SESSION_ID?.trim() || "example-langchain-thread";

  const result = await agent.invoke(
    {
      messages: [
        {
          role: "user",
          content: "What is 3 times 7? Use the multiply tool.",
        },
      ],
    },
    {
      configurable: { thread_id: threadId, user_id: "example-user" },
    },
  );

  await handler.flush();

  console.log(
    JSON.stringify({
      ok: true,
      sessionId: threadId,
      model: label,
      messageCount: result.messages?.length ?? 0,
      message: "check Explorer Sessions for this thread_id",
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
