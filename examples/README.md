# Softprobe JS examples

Public, docs-faithful samples for Softprobe Agent QA TypeScript SDKs.

Customer install steps match [Agent QA → LangChain](https://docs.softprobe.ai/en/agent-qa/langchain) and [Quick start](https://docs.softprobe.ai/en/agent-qa/getting-started).

| Example | What it shows |
|---------|----------------|
| [`basic`](./basic) | `SoftprobeClient.fromEnv()` — agent + generation |
| [`langchain`](./langchain) | Env auto / `instrument()` + app `thread_id` |
| [`phase2-ts/`](./phase2-ts/) | Nested agent/session propagation and score writes |
| [`phase3-live-ts/`](./phase3-live-ts/) | Live OpenAI model capture |
| [`tool-call-ts/`](./tool-call-ts/) | Agent → generation → correlated tool calls |
| [`opencode-plugin-ts/`](./opencode-plugin-ts/) | OpenCode plugin instrumentation |

Python examples live in the public Python SDK repo:
[`softprobe/softprobe-py`](https://github.com/softprobe/softprobe-py/tree/main/examples).

## Credentials

```bash
export SOFTPROBE_PUBLIC_KEY="spk_…"
export SOFTPROBE_BASE_URL="https://explorer.softprobe.ai/api/thelake"
# optional:
export SOFTPROBE_ENVIRONMENT="Production"
```

For local thelake started with `SOFTPROBE_LOCAL_ANONYMOUS=1`, set
`SOFTPROBE_BASE_URL=http://127.0.0.1:8090` and any non-empty
`SOFTPROBE_PUBLIC_KEY`; thelake ignores credentials in that explicit mode.

## Run

```bash
# from softprobe-js root
npm install && npm run build

cd examples/basic && npm install && npm start
cd examples/langchain && npm install && npm start
cd examples/phase2-ts && npm install && npm start
cd examples/phase3-live-ts && npm install && npm start
cd examples/tool-call-ts && npm install && npm start
cd examples/opencode-plugin-ts && npm install && npm start
```

`langchain` needs `GEMINI_KEY` / `GOOGLE_API_KEY` or `OPENAI_API_KEY`. Default model is Gemini.
