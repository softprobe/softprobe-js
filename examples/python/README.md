# Softprobe Python examples (public browse)

These scripts are the public GitHub copies of the Agent QA Python examples.
They require the published SDK:

```bash
pip install 'softprobe[langchain]'
# or: pip install softprobe
```

Canonical copies also ship inside the `softprobe` package under `examples/`
(workspace path: `sp-llm/packages/softprobe-python/examples/`).

| File | Docs path |
|------|-----------|
| [`basic.py`](./basic.py) | `SoftprobeClient.from_env()` |
| [`langchain_agent.py`](./langchain_agent.py) | [LangChain install](https://docs.softprobe.ai/en/agent-qa/langchain) |

```bash
export SOFTPROBE_PUBLIC_KEY="spk_…"
export SOFTPROBE_BASE_URL="https://explorer.softprobe.ai/api/thelake"

python basic.py

# GEMINI_KEY / GOOGLE_API_KEY or OPENAI_API_KEY:
pip install langgraph langchain-google-genai langchain-openai
python langchain_agent.py
```
