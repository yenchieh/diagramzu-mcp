# @diagramzu/mcp

MCP server for [diagramzu.ai](https://diagramzu.ai). Lets Claude Code, Cursor, ChatGPT custom GPTs, and any MCP client read and write diagrams in your Space.

## Use the hosted server (recommended)

You do not need to clone or build this package. diagramzu hosts a remote MCP
server. You only need an API token (`dz_live_…`) from
`https://diagramzu.ai/app/settings/tokens` — the space is derived from the
token.

```bash
claude mcp add --transport http diagramzu https://diagramzu.ai/mcp \
  --header "Authorization: Bearer dz_live_xxx"
```

Claude Desktop / Cursor: add an `http`-type server in your MCP config:

```json
{
  "mcpServers": {
    "diagramzu": {
      "type": "http",
      "url": "https://diagramzu.ai/mcp",
      "headers": { "Authorization": "Bearer dz_live_xxx" }
    }
  }
}
```

Full reference: **https://diagramzu.ai/docs**.

## Local development (this repo)

This stdio package is kept for hacking on diagramzu itself:

```bash
cd packages/mcp-diagramzu
pnpm install
pnpm run build
# point your client at node dist/index.js with
# DIAGRAMZU_BASE_URL / DIAGRAMZU_API_TOKEN / DIAGRAMZU_SPACE_ID
```

## Tools

| Tool | Description |
|---|---|
| `list_diagrams` | List every diagram in the Space |
| `get_diagram` | Fetch one by id |
| `create_diagram` | Create a new diagram (returns share URL) |
| `update_diagram` | Update title and/or mermaid source |
