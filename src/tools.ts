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
          folderId: {
            type: "string",
            description:
              "Optional UUID — narrow to diagrams in this folder. Use list_folders to look up folder ids. Omit to see every folder (the default).",
          },
        },
        additionalProperties: false,
      },
    },
    async (args) => {
      const params: { q?: string; owner?: string; sort?: "created" | "updated" | "title"; folderId?: string } = {};
      if (typeof args.q === "string") params.q = args.q;
      if (typeof args.owner === "string") params.owner = args.owner;
      if (args.sort === "created" || args.sort === "updated" || args.sort === "title") {
        params.sort = args.sort;
      }
      if (typeof args.folderId === "string") params.folderId = args.folderId;
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
    "list_folders",
    {
      description:
        "List every folder in the configured Space, ordered by name. Returns id and full path (e.g. 'Infra/AWS' for a nested folder). " +
        "Use this BEFORE create_diagram or update_diagram when you want to place a diagram in a meaningful folder — " +
        "agents should match by name (e.g. find a folder named 'Schemas' and pass its id as folderId). " +
        "Folders are at most two levels deep. Creating folders is currently human-only.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => {
      const { folders } = await client.listFolders();
      if (folders.length === 0) {
        return { content: [{ type: "text", text: "(no folders yet)" }] };
      }
      const byId = new Map(folders.map((f) => [f.id, f]));
      const lines = folders.map((f) => {
        if (f.parentId === null) return `${f.id}  ${f.name}`;
        const parent = byId.get(f.parentId);
        return parent ? `${f.id}  ${parent.name}/${f.name}` : `${f.id}  ${f.name}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "get_diagram",
    {
      description:
        "Fetch one diagram by id. Returns its title, description (the agent's brief), mermaid source code, and a shareable URL. " +
        "Read the description before editing — it tells you what the diagram is for and when to update it.",
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
      const shareUrl = await client.getActiveShareUrl(diagram.id);
      const sections = [`# ${diagram.title}`];
      if (diagram.description) sections.push(`> ${diagram.description}`);
      const footer = shareUrl ? `---\nOpen: ${url}\nShare: ${shareUrl}` : `---\nOpen: ${url}`;
      sections.push(diagram.code, footer);
      return {
        content: [{ type: "text", text: sections.join("\n\n") }],
      };
    },
  );

  server.registerTool(
    "create_diagram",
    {
      description:
        "Create a new diagram in the Space. Returns its id and shareable URL. " +
        "Use `class` (not `classDef`) with role names `edge`/`core`/`data`/`accent`/`muted` to color-group related nodes (3–5 roles) — see this server's instructions.",
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
              "Overall purpose of the diagram (≤1000 chars). Shown to share-link viewers and surfaced back to the agent as the diagram's brief — write this before generating the code.",
          },
          folderId: {
            type: "string",
            description:
              "Optional UUID of an existing folder to place the diagram in. Use list_folders first to find the right folder by name (e.g. 'Infra', 'Schemas'). Omit to place at the space root.",
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
        folderId?: string;
      } = {};
      if (typeof args.title === "string") body.title = args.title;
      if (typeof args.code === "string") body.code = args.code;
      if (typeof args.style === "string") body.style = args.style;
      if (args.styleOptions && typeof args.styleOptions === "object") {
        body.styleOptions = args.styleOptions as Record<string, unknown>;
      }
      if (typeof args.description === "string") body.description = args.description;
      if (typeof args.folderId === "string") body.folderId = args.folderId;
      const { diagram, warnings } = await client.create(body);
      const lines = [`Created: ${diagram.id}`, client.diagramUrl(diagram.id)];
      const shareUrl = await client.getActiveShareUrl(diagram.id);
      if (shareUrl) lines.push(`Share: ${shareUrl}`);
      if (warnings && warnings.length) {
        lines.push("", "Warnings:", ...warnings.map((w) => `- ${w}`));
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );

  server.registerTool(
    "update_diagram",
    {
      description:
        "Update an existing diagram's title, description, mermaid source, visual style preset, and/or layout style options. " +
        "When rewriting the source, keep or restore `class` assignments using the role names from this server's instructions so the diagram stays color-grouped.",
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
              "Overall purpose of the diagram (≤1000 chars). Shown to share-link viewers and surfaced back to the agent as the diagram's brief — write this before generating the code.",
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
          folderId: {
            type: "string",
            description:
              "Optional UUID of an existing folder to move this diagram into. Use list_folders to look up folder ids. (Moving back to root is currently human-only.)",
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
        folderId?: string;
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
      if (typeof args.folderId === "string") body.folderId = args.folderId;
      if (
        body.title === undefined &&
        body.code === undefined &&
        body.style === undefined &&
        body.styleOptions === undefined &&
        body.description === undefined &&
        body.folderId === undefined
      ) {
        throw new Error(
          "Provide at least one of title, code, style, styleOptions, description, or folderId.",
        );
      }
      const { diagram, versionId, warnings } = await client.update(id, body);
      const lines = [`Updated: ${diagram.id}`];
      if (versionId) lines.push(`Snapshot: ${versionId}`);
      lines.push(client.diagramUrl(diagram.id));
      const shareUrl = await client.getActiveShareUrl(diagram.id);
      if (shareUrl) lines.push(`Share: ${shareUrl}`);
      if (warnings && warnings.length) {
        lines.push("", "Warnings:", ...warnings.map((w) => `- ${w}`));
      }
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
