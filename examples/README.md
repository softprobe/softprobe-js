# Softprobe JS examples

Public, docs-faithful samples for Softprobe Agent QA SDKs.

Customer install steps match [Agent QA → LangChain](https://docs.softprobe.ai/en/agent-qa/langchain) and [Quick start](https://docs.softprobe.ai/en/agent-qa/getting-started).

| Example | Language | What it shows |
|---------|----------|----------------|
| [`basic`](./basic) | TypeScript | `SoftprobeClient.fromEnv()` — agent + generation |
| [`langchain`](./langchain) | TypeScript | Env auto / `instrument()` + app `thread_id` |
| [`python`](./python) | Python | Same paths via `pip install softprobe` |

## Credentials

```bash
export SOFTPROBE_PUBLIC_KEY="spk_…"
export SOFTPROBE_BASE_URL="https://explorer.softprobe.ai/api/thelake"
# optional:
export SOFTPROBE_ENVIRONMENT="Production"
```

Local thelake: `SOFTPROBE_BASE_URL=http://127.0.0.1:8091` and a token your stack accepts.

## Run TypeScript (this repo)

```bash
# from softprobe-js root
npm install && npm run build

cd examples/basic && npm install && npm start
cd examples/langchain && npm install && npm start
```

`langchain` needs `GEMINI_KEY` / `GOOGLE_API_KEY` or `OPENAI_API_KEY`. Default model is Gemini.

## Run Python

```bash
pip install 'softprobe[langchain]'
cd examples/python && python basic.py
```
