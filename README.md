# MCP Nexus for Node.js

[English](README.md) | [繁體中文](README.zh-TW.md)

MCP Nexus is a self-hosted Model Context Protocol (MCP) gateway and AI research control plane. It connects remote Streamable HTTP MCP servers, exposes aggregated or single-upstream tool endpoints, and runs bounded OpenAI-compatible Agent workflows from a browser dashboard.

The original stdio search server remains available as a separate entrypoint. This repository is the independent Node.js implementation; the Python project has a separate runtime and release path.

> **Project status:** Functional single-process MVP. It is suitable for local, private-network, and carefully controlled self-hosted deployments. OAuth, multi-instance state coordination, and hardened public multi-tenant operation are not implemented.

## Table of contents

- [Highlights](#highlights)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Using MCP Nexus](#using-mcp-nexus)
- [Configuration](#configuration)
- [Pterodactyl deployment](#pterodactyl-deployment)
- [Security model](#security-model)
- [Development](#development)
- [Project structure](#project-structure)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [Security reports](#security-reports)
- [License](#license)

## Highlights

- First-run registration for one administrator, after which registration is closed.
- Configurable login path plus a persisted, refreshable `/<uuid>/web` control-plane path.
- OpenAI-compatible Agent orchestration with precision, fixed parallel, and custom parallel modes.
- Research-only `curl` and `searxng_search` Function Tools with strict network and resource limits.
- User-operated SearXNG support for Google, Bing, DuckDuckGo, Startpage, and default SearXNG aggregation.
- Remote Streamable HTTP MCP servers with custom Header or URL Query authentication.
- Aggregated `/mcp` tools named `<alias>.<tool>` and single-upstream `/mcp/<alias>` forwarding.
- Up to 20 named Gateway tokens with per-token counters and a bounded request log.
- Low-memory safeguards for 128 MB containers.
- Responsive black-and-cyan dashboard with reduced-motion support.

## Architecture

```text
Browser
  -> Express control plane
     -> validated in-process state snapshot
     -> atomic JSON persistence
     -> OpenAI-compatible Agent orchestrator
        -> Research Agents only: bounded curl / SearXNG tools

MCP client
  -> /mcp or /mcp/<alias>
     -> Gateway token authentication
     -> bounded MCP session registry
     -> remote Streamable HTTP MCP servers

stdio MCP client
  -> dist/server.js
     -> in-memory document search service
```

The Web gateway currently aggregates MCP **tools**. Agent network tools are separate from configured remote MCP tools: Planner, Reviewer, and Synthesizer Agents receive no network tools, and no Agent receives remote MCP tools.

## Requirements

- Node.js 20 or newer
- npm compatible with the installed Node.js release
- A populated `.env` file for the Web launcher
- Optional: an OpenAI-compatible Chat Completions provider
- Optional: a self-hosted SearXNG instance with `json` enabled in `search.formats`

## Quick start

### 1. Create the environment file

Linux or macOS:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env` before starting. At minimum, review `WEB_LOGIN_PATH` and the listener settings.

### 2. Install and verify

```bash
npm ci
npm run check
```

### 3. Start the Web control plane

```bash
node start.js
```

`start.js` uses an existing compiled entrypoint when available. If `dist/web-server.js` is missing, it installs development dependencies and builds the project; if that fails, it makes one final attempt through the project-local `tsx` loader.

Open the configured login URL, for example:

```text
http://127.0.0.1:3000/yoyo/s12ryt/login
```

Create the sole administrator. The first Gateway token is shown once; store it immediately. After login, the browser redirects to the persisted `/<uuid>/web` path.

## Using MCP Nexus

### Web control plane

The dashboard provides:

- **AI Search:** executes the configured Agent workflow and shows stages, usage, and SearXNG evidence.
- **Search Orchestration:** controls Agent mode, concurrency, history bounds, output tokens, sampling, role prompts, and SearXNG.
- **MCP Servers:** manages remote MCP endpoints, authentication parameters, connectivity tests, and forwarding URLs.
- **Gateway Token:** creates and revokes named tokens and shows final-five-character identifiers and counters.
- **Request Log:** shows the latest 200 authenticated MCP HTTP requests without request parameters or complete tokens.
- **Settings:** configures the OpenAI-compatible provider and refreshes the private Web UUID.

### HTTP MCP gateway

Use a Gateway token as a Bearer credential:

```http
Authorization: Bearer <gateway-token>
```

Available Streamable HTTP endpoints:

- `POST /mcp` exposes enabled upstream tools as `<alias>.<tool>`.
- `POST /mcp/<alias>` exposes one enabled upstream and preserves original tool names.

Clients must complete MCP initialization before subsequent session requests. MCP session IDs, request IDs, upstream credentials, and downstream Gateway tokens remain separate.

### stdio MCP server

Build the project and invoke the generated file directly so npm lifecycle output cannot enter protocol stdout:

```bash
npm run build
node dist/server.js
```

Example client configuration:

```json
{
  "mcpServers": {
    "focused-search-node": {
      "command": "node",
      "args": ["/absolute/path/to/nodejs/dist/server.js"]
    }
  }
}
```

The stdio server exposes the read-only `search_index` and `get_document` tools backed by an in-memory repository.

### Agent search orchestration

- **Precision:** Planner -> Search/Analysis -> Reviewer -> Synthesizer.
- **Parallel:** five Search/Analysis Agents -> one Synthesizer.
- **Custom parallel:** one to eight Search/Analysis Agents -> one Synthesizer.

The history limit controls how many characters of prior stage output are supplied to the next Agent; it does not change the provider model's context window. `max_tokens` is bounded from 128 to 4096 for each completion. Only the selected `temperature` or `top_p` control is sent.

Only Search/Analysis Agents may receive these optional tools:

- `searxng_search`: uses the administrator's saved endpoint, sources, result limit, language, and SafeSearch settings.
- `curl`: accepts an HTTP(S) URL, method, request headers, and optional body without invoking a shell.

Each Search/Analysis Agent is limited to three tool rounds and six executions, with four calls per round. One search has a shared limit of 12 tool executions. Tool operations are serialized; after the round limit, the provider receives a final request with `tool_choice: "none"`.

### Self-hosted SearXNG

The configured SearXNG instance must enable JSON responses:

```yaml
search:
  formats:
    - html
    - json
```

Google, Bing, DuckDuckGo, and Startpage selections set the corresponding SearXNG `engines` value. The SearXNG selection omits `engines` and uses the instance's enabled defaults.

Single mode requires one source. Parallel mode accepts up to five selected sources and runs at most two HTTP searches concurrently. Each source returns at most 10 results. URLs are canonicalized and deduplicated; a failed source does not discard successful sources.

### Remote MCP authentication

Each remote server supports up to 20 authentication parameters and 32,000 total secret characters:

- **HTTP Header**, recommended for `Authorization`, `X-API-Key`, and similar credentials.
- **URL Query**, only when required by the upstream service because URLs may be logged by intermediaries.

Configuration APIs return only parameter locations and names. Secret values remain in server-side state. Duplicate, malformed, control-character, transport-managed, and unsafe Header names are rejected.

## Configuration

| Variable | Default | Description |
|---|---:|---|
| `HOST` | `127.0.0.1` | Web listener address |
| `PORT` | `3000` | Web listener port |
| `MCP_NEXUS_DATA` | `data/state.json` | JSON state path, relative to the project root when not absolute |
| `WEB_LOGIN_PATH` | `/login` | Exact login page and authentication API prefix |
| `ALLOW_PRIVATE_UPSTREAMS` | unset | Set to `true` only for trusted local development |
| `MCP_MAX_SESSIONS` | `8` | Retained MCP sessions; accepted range 1-64 |
| `MCP_SESSION_IDLE_MS` | `900000` | Opportunistic idle expiry; accepted range 30000-86400000 ms |
| `MCP_MAX_TOOLS` | `256` | Maximum collected upstream tools; accepted range 1-2048 |
| `MCP_MAX_AI_RESPONSE_BYTES` | `1048576` | Maximum OpenAI-compatible response; accepted range 16384-8388608 bytes |
| `MCP_AI_TIMEOUT_MS` | `120000` | Per-request OpenAI-compatible timeout; accepted range 10000-300000 ms |

Shell and panel variables take precedence over `.env`. Web entrypoints load `.env` from the project root regardless of the caller's working directory. Reserved API, MCP, and asset prefixes cannot be used as `WEB_LOGIN_PATH`.

The JSON state is parsed and validated once per process, then retained as an internal snapshot. Updates remain schema-validated and atomically replace the file before the snapshot changes. Manual file edits are not hot-reloaded; restart the service to load them.

## Pterodactyl deployment

Use a Generic Node egg with Node.js 20 or newer.

Recommended startup command for a 128 MB container:

```bash
node --max-old-space-size=48 --max-semi-space-size=2 start.js
```

- Upload a populated `.env` beside `start.js`.
- `SERVER_PORT` maps to `PORT`.
- The listener defaults to `0.0.0.0` in a detected panel environment unless `HOST` is explicitly set.
- Use `MCP Nexus login available at` as the startup completion text.
- Use `^C` as the stop command so Wings sends `SIGINT`.
- Do not place `NODE_OPTIONS` in `.env`; V8 heap flags must be present before Node.js starts.

## Security model

- Loopback binding by default and Host validation for local listeners.
- HttpOnly, SameSite=Strict browser sessions and CSRF checks for authenticated writes.
- Scrypt administrator password hashes and SHA-256 Gateway token fingerprints.
- One-time display of complete Gateway token values; only the final five characters are retained for identification.
- HTTPS-only public outbound requests by default, URL credential rejection, redirect rejection, SSRF checks, and DNS address pinning for Agent `curl`.
- Bounded sessions, request logs, catalogs, response bodies, prompts, Agent history, tool rounds, headers, and request bodies.
- Provider, upstream MCP, cookie, and Gateway secrets are never injected into Agent tools.
- Titles, snippets, URLs, and direct HTTP responses are treated as untrusted evidence in Agent prompts.

`ALLOW_PRIVATE_UPSTREAMS=true` relaxes HTTP and private-network restrictions for upstream MCP, SearXNG, and Agent HTTP requests. Use it only in trusted development environments.

Do not expose the service publicly without TLS, reverse-proxy controls, and an explicit network policy. The custom login path and Web UUID reduce accidental discovery but do not replace authentication.

## Development

| Command | Purpose |
|---|---|
| `npm run dev` | Run the TypeScript stdio server |
| `npm run dev:web` | Run the TypeScript Web service |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run strict TypeScript checking without output |
| `npm test` | Run Vitest once |
| `npm run check` | Lint, typecheck, build, and test |
| `npm run start:web` | Run the production launcher |

Before submitting changes:

```bash
npm ci
npm run check
npm audit --omit=dev
```

## Project structure

```text
src/                 TypeScript services, policies, MCP adapters, and entrypoints
public/              Zero-build browser control plane
tests/               Unit and integration tests
docs/                Historical decisions and roadmap documents
.github/              CI, issue forms, dependency updates, and PR template
start.js             Pterodactyl-compatible production launcher
.env.example         Web configuration template
CONTRIBUTING.md      Contribution workflow
SECURITY.md          Vulnerability reporting policy
LICENSE              AGPL-3.0-or-later license text
```

Some files in `docs/` describe the original stdio scaffold and may lag behind the current Web gateway. This README is the authoritative runtime overview until those documents are revised.

## Limitations

- Single-process runtime with one JSON state file; multiple instances must not write the same file.
- No OAuth provider or public multi-tenant authorization server.
- MCP gateway aggregation is tools-first; prompts and resources are not aggregated.
- AI completions are non-streaming.
- Direct external edits to the state file require a restart.
- The stdio document search repository is in memory and does not crawl or persist documents.
- The Python control plane is not implemented in this repository.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), keep changes focused, add tests for behavior changes, and run `npm run check` before opening a pull request.

By contributing, you agree that your contribution is licensed under `AGPL-3.0-or-later`.

## Security reports

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md) and use private vulnerability reporting when a public remote enables it.

## License

Licensed under the [GNU Affero General Public License v3.0 or later](LICENSE). Modified network deployments must offer corresponding source as required by the license.
