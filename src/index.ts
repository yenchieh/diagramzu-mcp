#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DiagramzuClient } from "./client.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
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
