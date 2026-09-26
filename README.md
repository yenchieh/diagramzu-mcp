# @diagramzu/mcp

[![smithery badge](https://smithery.ai/badge/jack08300/diagramzu-mcp)](https://smithery.ai/server/jack08300/diagramzu-mcp)

MCP server for [diagramzu.ai](https://diagramzu.ai). Lets Claude Code, Claude Desktop, Cursor, Windsurf, ChatGPT custom GPTs, and any [MCP](https://modelcontextprotocol.io) client read and write Mermaid diagrams in your Space.

You author diagrams by talking to your AI — it stores them in your Space at `diagramzu.ai/app/d/<id>`, where your team can read them and publish a public link.

> Available in the official [MCP Registry](https://registry.modelcontextprotocol.io) as `ai.diagramzu/mcp`.

## 1. Get a token

Sign up at [diagramzu.ai](https://diagramzu.ai), then create an API token at [diagramzu.ai/app/settings/connections](https://diagramzu.ai/app/settings/connections). Tokens look like `dz_live_…` and are scoped to one Space — no separate space-id needed.

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
| `get_diagram` | Fetch one diagram by id (title, description, Mermaid source) |
| `create_diagram` | Create a new diagram (returns its id and its `/app/d/<id>` URL) |
| `update_diagram` | Update title, Mermaid source, description, or style of an existing diagram |
| `analyze_diagram` | Get a structural summary of a diagram (nodes, edges, density) |
| `list_versions` | List version history for a diagram |
| `get_version` | Fetch a specific historical version of a diagram |
| `list_comments` | List a diagram's comments, oldest first (optionally only one node's thread) |
| `add_comment` | Post a comment, optionally pinned to a node or replying to a thread |
| `list_decks` | List presentation decks in the Space, newest-edited first |
| `get_deck` | Fetch one deck by id, with its ordered slides |
| `create_deck` | Assemble existing diagrams into an ordered presentation deck |
| `update_deck` | Change a deck's title, description, or slide order (`slides` is declarative) |

## Which URLs are public

Two different things get called "a link" here, and only one of them works for
someone outside your Space:

| URL | Who can open it |
|---|---|
| `diagramzu.ai/app/d/<id>` | Space members only — the diagram in the app. |
| `diagramzu.ai/app/present/<deck id>` | Space members only — the deck's presentation view. |
| `diagramzu.ai/s/<slug>` | Anyone with the link — the public, read-only diagram page. |
| `diagramzu.ai/s/p/<slug>` | Anyone with the link — the public, read-only deck. |

The tools hand back the `/app/…` URLs, so a link pasted straight out of a chat is
a members-only one: send it to someone outside the Space and they land on
sign-in. Publishing is a person's decision, not an agent's — open the diagram or
deck in DiagramZu and use its Share button to mint the public link. Once a
diagram has one, `get_diagram` and `update_diagram` report it on a `Share:` line
of their own.

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
