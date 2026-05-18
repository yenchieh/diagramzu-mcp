import type { DiagramzuClient } from "./client.js";

interface ToolHandler {
  (args: Record<string, unknown>): Promise<{ content: { type: "text"; text: string }[] }>;
}

interface ToolRegistry {
  registerTool: (
    name: string,
    spec: { description: string; inputSchema: Record<string, unknown> },
    handler: ToolHandler,
  ) => void;
}

export function registerTools(server: ToolRegistry, client: DiagramzuClient): void {
  server.registerTool(
    "list_diagrams",
    {
      description: "List every diagram in the configured Space. Returns id, title, and updatedAt for each.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => {
      const { diagrams } = await client.list();
      const lines = diagrams.map((d) => `${d.id}  ${d.title}  (updated ${d.updatedAt})`);
      return {
        content: [
          { type: "text", text: lines.length ? lines.join("\n") : "(no diagrams yet)" },
        ],
      };
    },
  );

  server.registerTool(
    "get_diagram",
    {
      description: "Fetch one diagram by id. Returns its title, mermaid source code, and a shareable URL.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Diagram UUID" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const id = String(args.id ?? "");
      if (!id) throw new Error("id is required");
      const { diagram } = await client.get(id);
      const url = client.diagramUrl(diagram.id);
      return {
        content: [
          { type: "text", text: `# ${diagram.title}\n\n${diagram.code}\n\n---\nOpen: ${url}` },
        ],
      };
    },
  );

  server.registerTool(
    "create_diagram",
    {
      description: "Create a new diagram in the Space. Returns its id and shareable URL.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Display name" },
          code: { type: "string", description: "Mermaid source. Defaults to a tiny flowchart." },
          style: {
            type: "string",
            enum: ["midnight", "paper", "forest", "ocean", "mono"],
            description:
              "Visual preset: midnight (default dark), paper, forest, ocean, mono. Omit to use the default.",
          },
        },
        additionalProperties: false,
      },
    },
    async (args) => {
      const body: { title?: string; code?: string; style?: string } = {};
      if (typeof args.title === "string") body.title = args.title;
      if (typeof args.code === "string") body.code = args.code;
      if (typeof args.style === "string") body.style = args.style;
      const { diagram } = await client.create(body);
      return {
        content: [
          { type: "text", text: `Created: ${diagram.id}\n${client.diagramUrl(diagram.id)}` },
        ],
      };
    },
  );

  server.registerTool(
    "update_diagram",
    {
      description: "Update an existing diagram's title and/or mermaid source.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          code: { type: "string" },
          style: {
            type: "string",
            enum: ["midnight", "paper", "forest", "ocean", "mono"],
            description:
              "Visual preset: midnight (default dark), paper, forest, ocean, mono.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const id = String(args.id ?? "");
      if (!id) throw new Error("id is required");
      const body: { title?: string; code?: string; style?: string } = {};
      if (typeof args.title === "string") body.title = args.title;
      if (typeof args.code === "string") body.code = args.code;
      if (typeof args.style === "string") body.style = args.style;
      if (
        body.title === undefined &&
        body.code === undefined &&
        body.style === undefined
      ) {
        throw new Error("Provide at least one of title, code, or style.");
      }
      const { diagram } = await client.update(id, body);
      return {
        content: [
          { type: "text", text: `Updated: ${diagram.id}\n${client.diagramUrl(diagram.id)}` },
        ],
      };
    },
  );
}
