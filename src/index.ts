#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DiagramzuClient } from "./client.js";
import { registerTools } from "./tools.js";

const baseUrl = (process.env.DIAGRAMZU_BASE_URL ?? "").replace(/\/$/, "");
const token = process.env.DIAGRAMZU_API_TOKEN ?? "";
const spaceId = process.env.DIAGRAMZU_SPACE_ID ?? "";

if (!baseUrl || !token || !spaceId) {
  console.error(
    "[diagramzu-mcp] missing required env: DIAGRAMZU_BASE_URL, DIAGRAMZU_API_TOKEN, DIAGRAMZU_SPACE_ID",
  );
  process.exit(1);
}

const client = new DiagramzuClient({ baseUrl, token, spaceId });

const SERVER_INSTRUCTIONS = `Diagramzu stores diagrams that humans read and share. Workflow:
1. Before creating: call list_diagrams to check if one on the same topic exists — prefer update_diagram over duplicating.
2. Before placing in a folder: call list_folders.
3. After creating/updating, share the returned URL with the user.

Make diagrams visually scannable. A flat single-color diagram is hard to read; one where every node is a different color is noise. Group related nodes and assign 3–5 color classes by MEANING (layer, status, ownership, type — not decoration), using mermaid's classDef + class syntax:

  flowchart TD
    A[Browser] --> B[CDN] --> C[Gateway]
    C --> D[Auth] & E[Billing]
    D & E --> F[(Database)]
    classDef edge fill:#dbeafe,stroke:#3b82f6,color:#1e3a8a
    classDef core fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef data fill:#dcfce7,stroke:#16a34a,color:#14532d
    class A,B edge
    class C,D,E core
    class F data

Layout is automatic — pass styleOptions.layout: "auto" (or omit) and the server picks the engine. Don't hand-tune layout unless the user asks.`;

const server = new Server(
  { name: "diagramzu", version: "0.0.1" },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
);

interface ToolReg {
  name: string;
  spec: { description: string; inputSchema: Record<string, unknown> };
  handler: (args: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>;
}
const tools: ToolReg[] = [];

registerTools(
  {
    registerTool: (name, spec, handler) => {
      tools.push({ name, spec, handler });
    },
  },
  client,
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({ name: t.name, description: t.spec.description, inputSchema: t.spec.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  return await tool.handler(req.params.arguments ?? {});
});

await server.connect(new StdioServerTransport());
