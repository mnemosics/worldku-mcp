# worldku-mcp

The official MCP server for [Worldku](https://www.worldku.com) memory. Save AI
conversations into your Worldku memory and recall them back — from Claude Code,
claude.ai, ChatGPT, Codex, Gemini CLI, or any other MCP client.

**Full setup guide: [worldku.com/docs/mcp](https://www.worldku.com/en/docs/mcp)** —
step-by-step instructions for every client, authentication details, and
troubleshooting. The same page in raw Markdown for AI agents:
[worldku.com/docs/mcp.md](https://www.worldku.com/docs/mcp.md).

The fastest way to set up: paste this into your AI tool and let it walk you
through —

> I want to give you long-term memory with Worldku. Read
> https://www.worldku.com/docs/mcp.md and walk me through connecting it, in
> your own words.

**Hosted service.** The public endpoint is `https://mcp.worldku.com/mcp`. This
repository is the open access layer only: the memory extraction pipeline, prompt
rules, and platform services run on Worldku's infrastructure. Self-hosting this
worker will not give you a working service — it exists for transparency and
review, and connects to backends that require Worldku credentials.

## Tools

| Tool | What it does | Cost |
|---|---|---|
| `memory_overview` | Most recent memories, one line each (zero parameters) | 1 read |
| `memory_search` | Semantic search over your memories | 1 read |
| `memory_recall` | Filtered recall: time range / type / source, paginated | 1 read |
| `memory_save` | Save the current conversation transcript for memory extraction | 1 save |

All tools fire only on your explicit ask — the tool descriptions instruct the
model never to call them from ambient association. Saved transcripts go through
Worldku's normal import pipeline: extraction runs asynchronously and new
memories land in your [memory workbench](https://www.worldku.com) marked unread.
Re-saving the same conversation is deduplicated server-side; extending a
previously saved conversation appends only the new tail.

## Connecting

Two authentication routes:

- **OAuth 2.1** — claude.ai and ChatGPT need no key at all: point them at the
  server URL and sign in at worldku.com when prompted.
- **Access key** — CLI clients use a `wk_mcp_…` key, minted at
  [worldku.com → Memory manager → AI tools](https://www.worldku.com/en/memorymanage?tab=connect).
  The key is shown once at mint time; up to 20 keys per account, each
  independently revocable.

### Claude Code

```bash
claude mcp add --transport http --scope user worldku https://mcp.worldku.com/mcp \
  --header "Authorization: Bearer wk_mcp_YOUR_KEY"
```

To keep the key out of the config file, export `WORLDKU_MCP_KEY` in your shell
profile and use single quotes: `--header 'Authorization: Bearer ${WORLDKU_MCP_KEY}'`.

### claude.ai (web, desktop, mobile)

Settings → Connectors → Add → **Add custom connector** →
`https://mcp.worldku.com/mcp` → sign in at worldku.com. No key needed.

### ChatGPT (web)

Enable **Developer mode** (Settings → Security and login), then create an app
at [chatgpt.com/plugins](https://chatgpt.com/plugins) with the server URL and
OAuth authentication. Sign in at worldku.com when prompted.

### Codex CLI

```bash
export WORLDKU_MCP_KEY=wk_mcp_YOUR_KEY
codex mcp add worldku --url https://mcp.worldku.com/mcp --bearer-token-env-var WORLDKU_MCP_KEY
```

### Gemini CLI

```json
// ~/.gemini/settings.json — note the httpUrl field name
{
  "mcpServers": {
    "worldku": {
      "httpUrl": "https://mcp.worldku.com/mcp",
      "headers": { "Authorization": "Bearer wk_mcp_YOUR_KEY" }
    }
  }
}
```

### Any other MCP client

Any client that supports Streamable HTTP with a custom header works:

- URL: `https://mcp.worldku.com/mcp`
- Header: `Authorization: Bearer wk_mcp_YOUR_KEY`

The config field holding the URL varies by client (`url` for most, `httpUrl`
for Gemini CLI, `serverUrl` for some others) — a wrong field name usually makes
the client ignore the server silently. More examples in [`examples/`](examples/)
and in the [full guide](https://www.worldku.com/en/docs/mcp).

## Protocol

- Native MCP revision **2026-07-28** (stateless Streamable HTTP): per-request
  metadata, no sessions, no SSE streams — every response is a single JSON
  object.
- Dual-era: the **2025-11-25** initialize-handshake era is also served (still
  statelessly — no session ids, no SSE), because that is what current-generation
  clients speak. This leg will be dropped once the client ecosystem moves to
  2026-07-28.
- `server/discover`, `tools/list`, `tools/call`, and the
  [Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview)
  (`tasks/get` / `tasks/update` / `tasks/cancel`) for async save polling.
  Clients that do not declare the extension get synchronous receipts instead.
- OAuth 2.1 resource server per the MCP authorization spec: RFC 9728 protected
  resource metadata at `/.well-known/oauth-protected-resource`, audience-bound
  opaque tokens, `memory:read` / `memory:write` scopes. The authorization
  server (worldku.com) supports Client ID Metadata Documents and PKCE `S256`.
- Discovery (SEP-2127 experimental): Server Card at
  [`/mcp/server-card`](https://mcp.worldku.com/mcp/server-card), AI Catalog at
  [`/.well-known/ai-catalog.json`](https://mcp.worldku.com/.well-known/ai-catalog.json).

## Limits

- 200 reads and 50 saves per user per day (anti-abuse caps, reset at 00:00 UTC).
- 10 MB per request.
- Reads and saves each book one usage action on your Worldku account. MCP
  access is included with every Worldku plan, including Free.

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm type-check
pnpm lint
```

Deployment (Cloudflare Workers) is done by the Worldku team — see
`wrangler.toml` for the binding surface (no secrets live in this repo).

## License

[MIT](LICENSE)
