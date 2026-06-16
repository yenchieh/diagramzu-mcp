# @diagramzu/mcp

MCP server for [diagramzu.ai](https://diagramzu.ai). Lets Claude Code, Claude Desktop, Cursor, Windsurf, ChatGPT custom GPTs, and any [MCP](https://modelcontextprotocol.io) client read and write Mermaid diagrams in your Space.

You author diagrams by talking to your AI — it stores them at `diagramzu.ai/d/<id>`, where your team can read and share them.

> Available in the official [MCP Registry](https://registry.modelcontextprotocol.io) as `ai.diagramzu/mcp`.

## 1. Get a token

Sign up at [diagramzu.ai](https://diagramzu.ai), then create an API token at [diagramzu.ai/app/settings/tokens](https://diagramzu.ai/app/settings/tokens). Tokens look like `dz_live_…` and are scoped to one Space — no separate space-id needed.

## 2. Connect your client

The hosted server is the easy path: no install, no build. Just paste a config.

### Claude Code

```bash
claude mcp add --scope user --transport http diagramzu https://mcp.diagramzu.ai/mcp \
  --header "Authorization: Bearer dz_live_xxx"
```

### Claude Desktop, Cursor, Windsurf, Cline

Add to your client's MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS for Claude Desktop, `~/.cursor/mcp.json` for Cursor, etc.):

```json
{
  "mcpServers": {
    "diagramzu": {
      "type": "http",
      "url": "https://mcp.diagramzu.ai/mcp",
      "headers": { "Authorization": "Bearer dz_live_xxx" }
    }
  }
}
```

### ChatGPT custom GPT (Actions)

In the GPT builder, add an MCP server action pointing to `https://mcp.diagramzu.ai/mcp` with a Bearer-token authentication header set to your `dz_live_…` token.

### Local stdio (for clients that don't speak remote MCP)

```bash
npx -y @diagramzu/mcp
```

with environment:

```
DIAGRAMZU_BASE_URL=https://diagramzu.ai
DIAGRAMZU_API_TOKEN=dz_live_xxx
DIAGRAMZU_SPACE_ID=<your space id>
```

Most users should prefer the remote HTTP transport above — the stdio path exists for clients without HTTP MCP support.

## Tools

| Tool | Description |
|---|---|
| `list_diagrams` | List diagrams in the Space (filter with `q`, sort by `updated` / `created`) |
| `list_folders` | List folders in the Space |
| `get_diagram` | Fetch one diagram by id (returns title + Mermaid source) |
| `create_diagram` | Create a new diagram (returns the share URL) |
| `update_diagram` | Update title and/or Mermaid source of an existing diagram |
| `analyze_diagram` | Get a structural summary of a diagram (nodes, edges, density) |
| `list_versions` | List version history for a diagram |
| `get_version` | Fetch a specific historical version of a diagram |

## Show off your setup

If you publish your MCP / Claude Code config in a dotfiles or example repo, drop this in the README so the next person knows where the diagrams come from:

```markdown
[![MCP: diagramzu](https://diagramzu.ai/badge/mcp.svg)](https://diagramzu.ai)
```

Renders as a small shields-style badge — gray `MCP` + indigo `diagramzu`.

## Local development (this repo)

For hacking on diagramzu itself, build from source:

```bash
cd packages/mcp-diagramzu
pnpm install
pnpm run build
# point your client at: node dist/index.js
# with DIAGRAMZU_BASE_URL / DIAGRAMZU_API_TOKEN / DIAGRAMZU_SPACE_ID
```

## License

MIT
