# Client configuration examples

All examples connect to the hosted endpoint `https://mcp.worldku.com/mcp` with a
Worldku MCP access key (`wk_mcp_…`, minted in the Worldku console under
Settings → MCP access; shown once at mint time).

## Claude Code

```bash
claude mcp add --transport http worldku https://mcp.worldku.com/mcp \
  --header "Authorization: Bearer wk_mcp_YOUR_KEY"
```

Then in a session: “把这段对话存进我的 Worldku 记忆” / “save this conversation
to my Worldku memory”, or “search my Worldku memory for …”.

## Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.worldku]
url = "https://mcp.worldku.com/mcp"
http_headers = { "Authorization" = "Bearer wk_mcp_YOUR_KEY" }
```

## Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "worldku": {
      "httpUrl": "https://mcp.worldku.com/mcp",
      "headers": { "Authorization": "Bearer wk_mcp_YOUR_KEY" }
    }
  }
}
```

## claude.ai custom connector

Settings → Connectors → Add custom connector → `https://mcp.worldku.com/mcp`.
Authentication runs through Worldku's OAuth flow (sign in with your Worldku
account and approve the scopes); no key is needed.

## Generic (any MCP client with custom headers)

- Transport: Streamable HTTP (MCP revision 2026-07-28)
- URL: `https://mcp.worldku.com/mcp`
- Header: `Authorization: Bearer wk_mcp_YOUR_KEY`
