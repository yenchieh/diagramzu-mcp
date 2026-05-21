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
      description:
        "List diagrams in the configured Space (every folder, newest first by default). " +
        "Use this BEFORE create_diagram to check whether a diagram with the target purpose already exists — " +
        "if it does, prefer update_diagram over creating a duplicate. " +
        "Filter with `q` (case-insensitive substring on title or code) when looking for a named diagram " +
        "(e.g. q: 'schema' or q: 'infra'). Sort with `sort: 'updated'` to find the most recently changed diagrams.",
      inputSchema: {
        type: "object",
        properties: {
          q: {
            type: "string",
            description:
              "Case-insensitive substring search on title and code. Use when looking for a named diagram (e.g. 'schema', 'infra').",
          },
          owner: {
            type: "string",
            description:
              "Filter to diagrams created by this user (Clerk user id, e.g. 'user_abc'). Rarely needed; omit unless the caller already has the user id.",
          },
          sort: {
            type: "string",
            enum: ["created", "updated", "title"],
            description:
              "Sort order. 'created' (default) = newest-first by creation; 'updated' = newest-first by last edit (use this to find the most recently changed diagram); 'title' = alphabetical.",
          },
        },
        additionalProperties: false,
      },
    },
    async (args) => {
      const params: { q?: string; owner?: string; sort?: "created" | "updated" | "title" } = {};
      if (typeof args.q === "string") params.q = args.q;
      if (typeof args.owner === "string") params.owner = args.owner;
      if (args.sort === "created" || args.sort === "updated" || args.sort === "title") {
        params.sort = args.sort;
      }
      const { diagrams } = await client.list(params);
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
          styleOptions: {
            type: "object",
            description:
              "Optional layout knobs, independent of the color preset. Each key is optional; omit any to keep its default. Pass layout: 'auto' to let the server pick a concrete layout based on the diagram's shape.",
            properties: {
              spacing: { type: "string", enum: ["compact", "cozy", "roomy"] },
              curve: { type: "string", enum: ["rounded", "straight", "stepped"] },
              line: { type: "string", enum: ["thin", "regular", "bold"] },
              arrow: { type: "string", enum: ["small", "regular", "large"] },
              layout: {
                type: "string",
                enum: [
                  "dagre",
                  "elk",
                  "elk.layered",
                  "elk.mrtree",
                  "elk.force",
                  "elk.stress",
                  "elk.sporeOverlap",
                  "auto",
                ],
              },
            },
            additionalProperties: false,
          },
          description: {
            type: "string",
            description:
              "Optional short purpose blurb (≤500 chars) shown to share-link viewers.",
          },
        },
        additionalProperties: false,
      },
    },
    async (args) => {
      const body: {
        title?: string;
        code?: string;
        style?: string;
        styleOptions?: Record<string, unknown>;
        description?: string | null;
      } = {};
      if (typeof args.title === "string") body.title = args.title;
      if (typeof args.code === "string") body.code = args.code;
      if (typeof args.style === "string") body.style = args.style;
      if (args.styleOptions && typeof args.styleOptions === "object") {
        body.styleOptions = args.styleOptions as Record<string, unknown>;
      }
      if (typeof args.description === "string") body.description = args.description;
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
      description:
        "Update an existing diagram's title, description, mermaid source, visual style preset, and/or layout style options.",
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
          styleOptions: {
            type: "object",
            description:
              "Optional layout knobs, independent of the color preset. Each key is optional; omit any to keep its default. Pass layout: 'auto' to let the server pick a concrete layout based on the diagram's shape.",
            properties: {
              spacing: { type: "string", enum: ["compact", "cozy", "roomy"] },
              curve: { type: "string", enum: ["rounded", "straight", "stepped"] },
              line: { type: "string", enum: ["thin", "regular", "bold"] },
              arrow: { type: "string", enum: ["small", "regular", "large"] },
              layout: {
                type: "string",
                enum: [
                  "dagre",
                  "elk",
                  "elk.layered",
                  "elk.mrtree",
                  "elk.force",
                  "elk.stress",
                  "elk.sporeOverlap",
                  "auto",
                ],
              },
            },
            additionalProperties: false,
          },
          description: {
            type: "string",
            description:
              "Optional short purpose blurb (≤500 chars) shown to share-link viewers.",
          },
          createVersion: {
            type: "boolean",
            description:
              "If true, snapshot the pre-update diagram state as a version row before applying the update. Use this to create a checkpoint right before an agent overwrites the diagram.",
          },
          versionLabel: {
            type: "string",
            description:
              "Optional short label for the snapshot taken when createVersion is true (max 80 chars).",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const id = String(args.id ?? "");
      if (!id) throw new Error("id is required");
      const body: {
        title?: string;
        code?: string;
        style?: string;
        styleOptions?: Record<string, unknown>;
        description?: string | null;
        createVersion?: boolean;
        versionLabel?: string;
      } = {};
      if (typeof args.title === "string") body.title = args.title;
      if (typeof args.code === "string") body.code = args.code;
      if (typeof args.style === "string") body.style = args.style;
      if (args.styleOptions && typeof args.styleOptions === "object") {
        body.styleOptions = args.styleOptions as Record<string, unknown>;
      }
      if (typeof args.description === "string") body.description = args.description;
      if (typeof args.createVersion === "boolean") body.createVersion = args.createVersion;
      if (typeof args.versionLabel === "string") body.versionLabel = args.versionLabel;
      if (
        body.title === undefined &&
        body.code === undefined &&
        body.style === undefined &&
        body.styleOptions === undefined &&
        body.description === undefined
      ) {
        throw new Error(
          "Provide at least one of title, code, style, styleOptions, or description.",
        );
      }
      const { diagram, versionId } = await client.update(id, body);
      const lines = [`Updated: ${diagram.id}`];
      if (versionId) lines.push(`Snapshot: ${versionId}`);
      lines.push(client.diagramUrl(diagram.id));
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );

  server.registerTool(
    "analyze_diagram",
    {
      description:
        "Analyze a stored flowchart diagram's structure (nodes, edges, subgraphs) and return actionable findings — orphan nodes, over-connected hubs, cycles, disconnected clusters, and grouping suggestions. Flowchart diagrams only.",
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
      const { text } = await client.analyze(id);
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "list_versions",
    {
      description:
        "List manual snapshots of a diagram, newest first. Returns id, label, title, createdAt, and createdBy for each.",
      inputSchema: {
        type: "object",
        properties: {
          diagramId: { type: "string", description: "Diagram UUID" },
          limit: { type: "number", description: "Max items to return (default 100, max 200)" },
          offset: { type: "number", description: "Items to skip (default 0)" },
        },
        required: ["diagramId"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const diagramId = String(args.diagramId ?? "");
      if (!diagramId) throw new Error("diagramId is required");
      const params: { limit?: number; offset?: number } = {};
      if (typeof args.limit === "number") params.limit = args.limit;
      if (typeof args.offset === "number") params.offset = args.offset;
      const { items, total } = await client.listVersions(diagramId, params);
      const lines = items.map(
        (v) => `${v.id}  ${v.label ?? "(no label)"}  ${v.title}  (${v.createdAt})`,
      );
      const summary = `${items.length} of ${total} version${total === 1 ? "" : "s"}`;
      return {
        content: [{ type: "text", text: [summary, ...lines].join("\n") }],
      };
    },
  );

  server.registerTool(
    "get_version",
    {
      description:
        "Fetch one snapshot by id. Returns its title, mermaid source code, and metadata. Read-only — restore is human-only in the UI.",
      inputSchema: {
        type: "object",
        properties: {
          diagramId: { type: "string", description: "Diagram UUID" },
          versionId: { type: "string", description: "Version UUID" },
        },
        required: ["diagramId", "versionId"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const diagramId = String(args.diagramId ?? "");
      const versionId = String(args.versionId ?? "");
      if (!diagramId || !versionId) throw new Error("diagramId and versionId are required");
      const { version } = await client.getVersion(diagramId, versionId);
      const header = `# ${version.title}` +
        (version.label ? ` (${version.label})` : "") +
        `\n_Created ${version.createdAt} by ${version.createdBy}_`;
      return {
        content: [{ type: "text", text: `${header}\n\n${version.code}` }],
      };
    },
  );
}
