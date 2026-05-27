// Server-level guidance returned to MCP clients via the `instructions` field.
// Must stay byte-identical to apps/web/server/utils/mcp/instructions.ts.
// Guarded by apps/web/tests/unit/mcpInstructionsParity.test.ts.
export const SERVER_INSTRUCTIONS = `Diagramzu stores diagrams that humans read and share. Workflow:
1. Before creating: call list_diagrams to check if one on the same topic exists — prefer update_diagram over duplicating.
2. Before placing in a folder: call list_folders.
3. After creating/updating, share the returned URL with the user.
4. When substantially rewriting an existing diagram's code, pass createVersion: true (optionally with versionLabel) so the prior state is snapshotted first.
5. Match the user's language — title, description, and node labels should use the language they wrote in.

Labels render as plain text. Use <br/> for line breaks. Do NOT use <b>, <strong>, <i>, markdown **bold**, or HTML attributes — they render as literal characters. Keep each label ≤4 short lines; longer labels overflow on dense layouts. Mermaid %%{init: ...}%% directives are not supported — use styleOptions instead.

Make diagrams visually scannable. A flat single-color diagram is hard to read; one where every node is a different color is noise. Group related nodes with \`class\` assignments — Diagramzu supplies the palette so colors coordinate with the diagram's visual style.

Coloring is about contrast, not categorization. One accent that holds <20% of nodes; the rest defaults to \`edge\`. Reach for a third role (\`core\` or \`data\`) only when there's a distinct meaning to convey beyond the accent. Roles available:
- \`edge\` — default / structural nodes (use this for most of the graph)
- \`accent\` — the one thing the diagram is *about* (keep this <20% of nodes)
- \`core\` — primary business logic, when distinct from edge
- \`data\` — persistence (DBs, caches, queues), when distinct from edge
- \`muted\` — external / legacy / de-emphasized

  flowchart TD
    A[Browser] --> B[CDN] --> C[Gateway]
    C --> D[Auth] & E[Billing]
    D & E --> F[(Database)]
    class A,B edge
    class C,D,E core
    class F data

Both \`class A,B edge\` (batch) and \`A[Browser]:::edge\` (inline) syntax work — use either.

Do not write \`classDef\` for these five names — Diagramzu injects the colors at render time. Custom colors not in the palette can use any other class name (e.g. \`classDef errorState fill:#dc2626\`).

Layout is automatic — pass styleOptions.layout: "auto" (or omit) and the server picks the engine. Don't hand-tune layout unless the user asks. ELK handles subgraphs with explicit \`direction\` better than dagre; for any multi-subgraph flowchart prefer styleOptions.layout: "elk.layered".

Side-by-side independent flows: wrap them in a parent subgraph with horizontal direction, then nest each flow as its own subgraph with vertical direction:

  flowchart TB
      subgraph WRAP[" "]
          direction LR
          subgraph A [Flow A]
              direction TB
              A1 --> A2
          end
          subgraph B [Flow B]
              direction TB
              B1 --> B2
          end
      end

Caveat: under ELK, sibling-subgraph left/right placement is decided by ELK's own heuristic (typically smaller subgraph first), not by declaration order or \`direction RL\` — currently not controllable from the source.

Aim for roughly 16:9 aspect ratio when possible — the share view scales-to-fit, so very tall or very wide diagrams shrink text past readability.`;
