import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { DiagramzuClient } from "./client.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { registerTools } from "./tools.js";

interface ToolReg {
  name: string;
  spec: { description: string; inputSchema: Record<string, unknown> };
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{ content: { type: "text"; text: string }[] }>;
}

/**
 * Build a transport-agnostic low-level MCP `Server` with the diagramzu tools
 * bound to `client`. Wires the ListTools / CallTool request handlers and
 * returns the Server WITHOUT connecting it to any transport — the caller picks
 * the transport:
 *   - stdio CLI (src/index.ts): `server.connect(new StdioServerTransport())`
 *   - remote service (services/mcp-svc): a per-request StreamableHTTPServerTransport
 *
 * This is the single source of truth for the tool wiring. Mirrors
 * apps/web/server/utils/mcp/server.ts (which the standalone service will
 * replace by reusing THIS function).
 */
export function buildServer(client: DiagramzuClient): Server {
  const server = new Server(
    { name: "diagramzu", version: "0.0.1" },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

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
    tools: tools.map((t) => ({
      name: t.name,
      description: t.spec.description,
      inputSchema: t.spec.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
    return await tool.handler(req.params.arguments ?? {});
  });

  return server;
}
