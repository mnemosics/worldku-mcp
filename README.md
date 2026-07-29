# worldku-mcp

The official MCP server for [Worldku](https://www.worldku.com) memory. Save AI
conversations into your Worldku memory and recall them back — from Claude Code,
Codex, Gemini CLI, claude.ai, or any other MCP client.

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

Authentication is a Worldku MCP access key (`wk_mcp_…`), minted in the Worldku
console (Settings → MCP access). The key is shown once at mint time.

### Claude Code

```bash
claude mcp add --transport http worldku https://mcp.worldku.com/mcp \
  --header "Authorization: Bearer wk_mcp_YOUR_KEY"
```

### Codex CLI

```toml
# ~/.codex/config.toml
[mcp_servers.worldku]
url = "https://mcp.worldku.com/mcp"
http_headers = { "Authorization" = "Bearer wk_mcp_YOUR_KEY" }
```

### Gemini CLI

```json
// ~/.gemini/settings.json
{
  "mcpServers": {
    "worldku": {
      "httpUrl": "https://mcp.worldku.com/mcp",
      "headers": { "Authorization": "Bearer wk_mcp_YOUR_KEY" }
    }
  }
}
```

### claude.ai (web)

Add `https://mcp.worldku.com/mcp` as a custom connector. Authentication runs
through Worldku's OAuth flow — no key needed.

### Any other MCP client

Any client that supports Streamable HTTP with a custom header works:

- URL: `https://mcp.worldku.com/mcp`
- Header: `Authorization: Bearer wk_mcp_YOUR_KEY`

More examples in [`examples/`](examples/).

## Protocol

- MCP revision **2026-07-28** (stateless Streamable HTTP). No legacy
  `initialize` handshake, no sessions, no SSE streams — every response is a
  single JSON object.
- `server/discover`, `tools/list`, `tools/call`, and the
  [Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview)
  (`tasks/get` / `tasks/update` / `tasks/cancel`) for async save polling.
  Clients that do not declare the extension get synchronous receipts instead.
- OAuth 2.1 resource server per the MCP authorization spec: RFC 9728 protected
  resource metadata at `/.well-known/oauth-protected-resource`, audience-bound
  opaque tokens, `memory:read` / `memory:write` scopes.

## Limits

- 200 reads and 50 saves per user per day (anti-abuse caps, reset at 00:00 UTC).
- 10 MB per request.
- Reads and saves each book one usage action on your Worldku account. The
  amount is currently 0.

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm type-check
pnpm lint
```

Deployment (Cloudflare Workers) requires Worldku secrets and is done from CI —
see `wrangler.toml` for the binding surface (no secrets live in this repo).

## License

[MIT](LICENSE)
