# ◆ Agent CLI

Autonomous AI coding agent for your terminal — it plans, edits files, runs commands in a sandbox, and verifies its own work before reporting back.

## Features

- **Agentic loop** — plans, calls tools, verifies, and iterates until the task is done
- **Native tool calling** — Anthropic (Claude) & OpenAI with automatic format translation
- **Resilience built-in** — input validation, safety checks, retry with exponential backoff, error recovery strategies, and a circuit breaker for failing tools
- **Workflow-aware automation** — maps frontend, backend, data, tests, and deployment before making cross-layer changes
- **Dependency/API support** — can install required libraries through the project package manager and integrate APIs through environment-based credentials
- **Three-layer memory** — separates temporary session notes, workspace project knowledge, and user-wide preferences; never stores secrets
- **Live TUI** — streaming output, tool activity feed, token usage bar, command history
- **Two interfaces** — classic readline REPL (`agent chat`) or Ink UI (`agent-ui`)

## Install

Requires Node.js 20 or newer.

```bash
npm install
npm run build
```

Set your API key:

```bash
export ANTHROPIC_API_KEY=your-key-here
# or
export OPENAI_API_KEY=your-key-here
```

## Usage

### Interactive chat (readline)

```bash
agent chat
agent chat -p openai -m gpt-4o
agent chat --permission-mode auto --max-iterations 50
```

### TUI (Ink)

```bash
agent-ui
agent-ui -m gpt-4o --mode fast
```

On first launch, `agent-ui` opens the IRIS quick setup if no API key is configured. To change provider, API key, model, or base URL later, run:

```bash
irissetting
```

The wizard saves credentials locally in `~/.agent/config.json` with owner-only file permissions. Alternatively, configure through environment variables such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

### One-shot task

```bash
agent run "add error handling to src/index.ts"
agent run --permission-mode safe --max-iterations 20 "review the auth flow"
```

`agent run` supports the same permission and iteration controls as `agent chat`.
Use `safe` when you want the agent to inspect without changing files.

### Full-stack automation

Use `automate` when one prompt should drive the complete workflow: map the project,
plan the affected layers, edit frontend/backend/data/config files, then run tests and
build checks.

```bash
agent automate --workspace . \
  "เพิ่มระบบสมัครสมาชิกให้ครบทั้งหน้าเว็บ API validation database migration และ tests"
```

The automation mode uses up to 80 iterations by default. Use `--permission-mode normal`
for approval before changes, or `--permission-mode auto` only in a trusted workspace.

### Utilities

```bash
agent init     # create .agent/config.json in this project
agent doctor   # check node, git, workspace, API keys
```

## Slash commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/status` | Agent status, iterations, tool calls |
| `/stats` | Tool performance report (success rate, latency) |
| `/tools` | List registered tools (live from the registry) |
| `/history` | Recent tool executions |
| `/model <name>` | Switch model |
| `/config` | Show configuration |
| `/reset` | Reset agent memory |
| `/clear` | Clear screen/view |
| `/exit` | Quit |

## Tools

| Tool | Description |
|---|---|
| `list_files` | Explore workspace structure |
| `read_file` | Read files (with line ranges) |
| `write_file` | Create or overwrite files |
| `edit_file` | Exact-match text replacement |
| `shell` | Run shell commands |
| `search_code` | Regex search across the project |
| `project_map` | Architecture/workflow map across frontend, backend, data, tests, and deployment |
| `project_memory` | Read/update non-secret `session`, `project`, or `global` memory |
| `git_status` / `git_diff` / `git_log` | Git inspection |

All file tools enforce workspace boundaries (symlink-safe path canonicalization) and every tool call passes schema validation + safety checks before execution.

### Sandbox & execution isolation

Shell commands never run bare. Two isolation tiers, selected automatically:

1. **Docker tier (default)** — every `shell` command runs inside a container with:
   - `--network none` (no inbound/outbound network)
   - memory / CPU / pids caps (`--memory`, `--cpus`, `--pids-limit`)
   - disk quota via `--ulimit fsize` and a read-only rootfs with a size-capped `noexec` tmpfs at `/tmp`
   - non-root user (`--user nobody` by default), `--cap-drop ALL`, `no-new-privileges`
   - the workspace as the only host bind-mount
2. **Local tier (no Docker)** — commands are wrapped with OS guards:
   - `ulimit` caps: CPU seconds, address space, file size, process count, core dumps off
   - `unshare -n` network-namespace isolation when available
   - `setpriv` demotion from root with all capabilities dropped (when running as root)
   - pre-flight rejection of commands referencing paths outside the workspace
     (absolute system paths, `~`, `$HOME`)

Set `AGENT_SANDBOX_REQUIRE_ISOLATION=true` to **fail closed**: shell commands are refused when Docker is unavailable instead of falling back to the guarded local tier.

```bash
export AGENT_SANDBOX_DOCKER_USER=1000:1000   # container user (default nobody)
export AGENT_SANDBOX_TMPFS_MB=256            # /tmp tmpfs + fsize quota (MB)
export AGENT_SANDBOX_REQUIRE_ISOLATION=true  # no local fallback
export AGENT_SANDBOX_LOCAL_CPU=30            # local ulimit -t (seconds)
export AGENT_SANDBOX_LOCAL_MEMORY_KB=1048576 # local ulimit -v
export AGENT_SANDBOX_LOCAL_PROCS=128         # local ulimit -u
export AGENT_SANDBOX_LOCAL_ALLOW_OUTSIDE=false # strict workspace paths
```

## Configuration

Global: `~/.agent/config.json` · Project: `.agent/config.json`

```json
{
  "provider": "anthropic",
  "model": "claude-3-5-sonnet-20241022",
  "permissionMode": "normal",
  "maxIterations": 30,
  "temperature": 0.7
}
```

Environment overrides: `AGENT_MODEL`, `AGENT_PROVIDER`, `AGENT_PERMISSION_MODE`, `AGENT_MAX_ITERATIONS`, `AGENT_DEBUG`.

### Server safety

The HTTP server binds to `127.0.0.1` and disables cross-origin requests by default.
It also runs in read-only permission mode unless mutations are explicitly enabled:

```bash
export ANTHROPIC_API_KEY=your-key-here
export AGENT_SERVER_ALLOW_MUTATIONS=true   # optional; enables write/command tools
export AGENT_SERVER_HOST=127.0.0.1         # optional
export AGENT_SERVER_ORIGIN=http://localhost:3000
npm run server
```

Do not expose the server directly to the public internet. Put authentication and TLS in
front of it before using a non-local bind address. The server requires a real
`ANTHROPIC_API_KEY`; it never falls back to a demo key.

### Web UI

The server also serves a single-page chat UI at `http://127.0.0.1:3000/` (open
`/agent-ui.html` directly if you front the server with your own router). It carries
a collapsible, resizable sidebar; a dark/light theme; tool activity cards; code
blocks; chat history in `localStorage`; and a metrics panel fed by
`/api/agent/report`.

Provider settings can be edited from the gear icon in the sidebar footer — or from
the channel popover in the header (provider + model + reasoning level) — without
restarting:

- `GET /api/agent/settings` → `{ model, baseUrl, hasApiKey, provider, thinkingLevel }`
- `PUT /api/agent/settings` → `{ model?, baseUrl?, apiKey?, clearApiKey?, provider?, thinkingLevel? }`

The API key is held in memory for the lifetime of the process and is never written
to disk, logged, or echoed back (only the `hasApiKey` boolean is reported).
Switching provider drops the in-memory key unless the environment already carries
one for the newly selected provider.

The non-secret half of the configuration — provider, model, base URL and reasoning
level — is persisted to `.agent/ui-settings.json` (gitignored) so a restart resumes
the same channel. That file contains no key material; the environment remains the
source of truth for the credential. Changing any setting drops the current agent so
the next request rebuilds it.

`thinkingLevel` is `off | low | medium | high`. Anthropic maps it to an extended-
thinking token budget (1024 / 4096 / 16384) and OpenAI maps it to
`reasoning_effort`; the budget is added on top of `max_tokens` as the Messages API
requires.

### Attachments

`POST /api/agent/run` accepts an optional `attachments` array:

```json
{ "message": "review these", "attachments": [{ "name": "shot.png", "mimeType": "image/png", "data": "<base64>" }] }
```

Up to 8 files, 8 MB each (12 MB request body). Images (`png`, `jpeg`, `gif`, `webp`)
are forwarded to the model as native image blocks; anything else is inlined as UTF-8
text when it decodes cleanly and under 200 KB, otherwise it is summarised by name and
size so the model can fetch it with a file tool.

### Live activity (SSE)

`GET /api/agent/events` is a Server-Sent Events stream that mirrors the agent's own
emitter: `toolStart`, `toolEnd` (with duration, retries, cache hit), `tokenUsage`,
`providerRetry`, `contextCompressed`, `specialtyRouted`, `securityAlert` and
`status`. The UI renders the tool list live while a run is in flight instead of
waiting for the reply. The last 50 events are replayed to a stream that connects
late. Payloads carry no credentials or environment values.

The UI carries its own icon set: Lucide symbols are inlined into the HTML by
`npm run ui:icons` (from the `lucide-static` dev dependency) so the page works with
no network access and under a strict `default-src 'none'` policy. The Mitr webfont
(SIL OFL) is vendored into `public/fonts/` and self-hosted, so Thai text renders
correctly without contacting a font CDN.

## Development

```bash
npm run dev        # typecheck & build in watch mode
npm test           # run unit tests
npm run typecheck  # tsc --noEmit
npm run server     # HTTP API around the agent (POST /api/agent/run)
```

## Project structure

```
src/
├── agent/          # Agent loop, routing/queue, recovery, prompt builder (prompts/)
├── memory/         # Notes, rules, code vectors, knowledge graph, learning
├── providers/      # Anthropic + OpenAI (native tool calling, streaming)
├── tools/          # File, shell, search, git, quality, build tools + registry
├── security/       # Permission modes, command policy, sandbox, scanners, backups
├── ui/             # Ink TUI (header, chat, input, status bar)
├── config/         # Config loader (global + project + env)
├── types/          # Shared types
├── createAgent.ts  # Wires provider + tools + permissions into an Agent
├── cli.ts          # readline entry (agent chat | run | init | doctor)
├── cli-ui.tsx      # Ink entry (agent-ui)
└── agent-server.ts # HTTP API entry (agent-server)
```

## License

MIT
