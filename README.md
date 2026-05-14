# @diagramzu/mcp

MCP server for [diagramzu.ai](https://diagramzu.ai). Lets Claude Code, Cursor, ChatGPT custom GPTs, and any MCP client read and write diagrams in your Space.

## Setup

1. Create an API token at `https://YOUR_DOMAIN/app/settings/tokens`. Copy the plaintext immediately.
2. Note your Space ID (the Clerk Organization ID, like `org_xxx`) — visible in the URL when you're in `/app/d/...`.
3. Build the server:

   ```bash
   cd packages/mcp-diagramzu
   pnpm install
   pnpm run build
   ```

4. Add to your Claude Code config:

   ```bash
   claude mcp add diagramzu \
     --env DIAGRAMZU_BASE_URL=https://diagramzu.ai \
     --env DIAGRAMZU_API_TOKEN=dz_live_xxx \
     --env DIAGRAMZU_SPACE_ID=org_xxx \
     -- node /absolute/path/to/packages/mcp-diagramzu/dist/index.js
   ```

## Tools

| Tool | Description |
|---|---|
| `list_diagrams` | List every diagram in the Space |
| `get_diagram` | Fetch one by id |
| `create_diagram` | Create a new diagram (returns share URL) |
| `update_diagram` | Update title and/or mermaid source |
