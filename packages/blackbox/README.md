# `@softprobe/blackbox`

CLI for initializing Softprobe Blackbox telemetry in terminal-first projects without an AI coding agent.

## Usage

```bash
npx @softprobe/blackbox init
```

Options:

- `--explorer-url <url>`: Explorer base URL (default: `https://explorer.softprobe.ai`)
- `--ingestion-key <key>`: Provide an existing ingestion key for non-interactive/CI setups
- `--project <name>`: Override the project name inferred from `package.json` or directory name
- `--env-file <path>`: Target env file (default: `.env`)
- `--no-open`: Print the OAuth URL without launching a browser
