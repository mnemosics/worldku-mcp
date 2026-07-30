# Client configuration examples

All examples connect to the hosted endpoint `https://mcp.worldku.com/mcp` with a
Worldku MCP access key (`wk_mcp_…`, minted at worldku.com → Memory manager →
AI tools — https://www.worldku.com/en/memorymanage?tab=connect; shown once at
mint time). Full per-client guide: https://www.worldku.com/en/docs/mcp

## Claude Code

```bash
claude mcp add --transport http --scope user worldku https://mcp.worldku.com/mcp \
  --header "Authorization: Bearer wk_mcp_YOUR_KEY"
```

Then in a session: “把这段对话存进我的 Worldku 记忆” / “save this conversation
to my Worldku memory”, or “search my Worldku memory for …”.

## Codex CLI

`~/.codex/config.toml`:

```toml
# after: export WORLDKU_MCP_KEY=wk_mcp_YOUR_KEY
[mcp_servers.worldku]
url = "https://mcp.worldku.com/mcp"
bearer_token_env_var = "WORLDKU_MCP_KEY"
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

Settings → Connectors → Add → Add custom connector → `https://mcp.worldku.com/mcp`.
Authentication runs through Worldku's OAuth flow (sign in with your Worldku
account and approve the scopes); no key is needed.

## ChatGPT (web)

Enable Developer mode (Settings → Security and login), then create an app at
https://chatgpt.com/plugins with the server URL and OAuth authentication; sign
in at worldku.com when prompted. No key is needed.

## Generic (any MCP client with custom headers)

- Transport: Streamable HTTP (MCP revision 2026-07-28)
- URL: `https://mcp.worldku.com/mcp`
- Header: `Authorization: Bearer wk_mcp_YOUR_KEY`
