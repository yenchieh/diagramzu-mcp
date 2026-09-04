import type { Actor, DiagramzuClient } from "./client.js";

// The client normalizes a non-2xx to `diagramzu API <status>: <body>`, and the
// 402 body emitted by go-api's CreateDiagram (services/go-api/internal/handlers/
// diagrams_write.go) carries the stable `diagram_limit` token + a `plan` field —
// so a substring match turns the diagram-cap 402 into an agent-legible refusal.
const DIAGRAM_LIMIT_ERROR = "diagram_limit";
const RATE_LIMIT_ERROR = "API 429";
// createRefusal turns the two create-path guards (Task 41) into agent-legible
// refusals, matched by substring on the normalized error string
// `diagramzu API <status>: <body>` produced by the client:
//   - 429                            → transient rate limit, retry
//   - 402 diagram_limit, plan:"pro"  → fair-use ceiling, no upgrade (already Pro)
//   - 402 diagram_limit, plan:"free" → upgrade CTA
// Returns null for anything else so the caller rethrows.
function createRefusal(err: unknown, upgradeUrl: string): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes(RATE_LIMIT_ERROR)) {
    return (
      `This workspace is creating diagrams faster than allowed (a brief rate limit ` +
      `that protects shared rendering). Wait a few seconds and try again.`
    );
  }
  if (msg.includes(DIAGRAM_LIMIT_ERROR)) {
    if (msg.includes('"plan":"pro"')) {
      return (
        `This workspace has reached its fair-use ceiling of 10,000 diagrams. Existing ` +
        `diagrams are unaffected. Delete some you no longer need, or contact support if ` +
        `your team genuinely needs a higher ceiling, then try again.`
      );
    }
    return (
      `This workspace has reached its 50-diagram limit on the Free plan. Existing diagrams ` +
      `are unaffected. The space owner can lift the limit by upgrading at ${upgradeUrl}, ` +
      `then try again.`
    );
  }
  return null;
}

// ── actor attribution (card 84) ───────────────────────────────────────────────
// The API returns an `actor` object per write ({kind, userId, tokenName}); an
// agent write carries a non-empty tokenName. Both helpers are defensive on
// purpose: this package is published to npm and can be pointed at a go-api
// older than card 84, which omits the field entirely. No actor, or a `user`
// actor, formats exactly as it did before the card.

/** The one extra `get_diagram` line, or null when the last write was a human's. */
function agentTokenLine(actor: Actor | undefined): string | null {
  const name = agentTokenName(actor);
  return name ? `Last updated by agent token \`${name}\`` : null;
}

/** The token name when `actor` is an agent, else null. */
function agentTokenName(actor: Actor | undefined): string | null {
  if (!actor || actor.kind !== "agent") return null;
  const name = actor.tokenName;
  return name ? name : null;
}

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
        "Filter with `q` (case-insensitive substring on title, description, or code) when looking for a named diagram " +
        "(e.g. q: 'schema' or q: 'infra'). Sort with `sort: 'updated'` to find the most recently changed diagrams, " +
        "or `sort: 'relevance'` when `q` is set so a title hit ranks above a description or code hit.",
      inputSchema: {
        type: "object",
        properties: {
          q: {
            type: "string",
            description:
              "Case-insensitive substring search on title, description, or code. Use when looking for a named diagram (e.g. 'schema', 'infra').",
          },
          owner: {
            type: "string",
            description:
              "Filter to diagrams created by this user (Clerk user id, e.g. 'user_abc'). Rarely needed; omit unless the caller already has the user id.",
          },
          sort: {
            type: "string",
            enum: ["created", "updated", "title", "relevance"],
            description:
              "Sort order. 'created' (default) = newest-first by creation; 'updated' = newest-first by last edit (use this to find the most recently changed diagram); 'title' = alphabetical; 'relevance' = title hits first, then description, then code (only when `q` is set; otherwise same as 'updated').",
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
      const params: { q?: string; owner?: string; sort?: "created" | "updated" | "title" | "relevance"; folderId?: string } = {};
      if (typeof args.q === "string") params.q = args.q;
      if (typeof args.owner === "string") params.owner = args.owner;
      if (args.sort === "created" || args.sort === "updated" || args.sort === "title" || args.sort === "relevance") {
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
      const agentLine = agentTokenLine(diagram.updatedActor);
      if (agentLine) sections.push(agentLine);
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
        "See this server's instructions for diagram-type selection and `class` role names (`edge`/`core`/`data`/`accent`/`muted`) for color-grouping.",
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
      let created: Awaited<ReturnType<typeof client.create>>;
      try {
        created = await client.create(body);
      } catch (e) {
        const refusal = createRefusal(e, `${client.siteBaseUrl}/app/settings/billing`);
        if (refusal) return { content: [{ type: "text", text: refusal }] };
        throw e;
      }
      const { diagram, warnings } = created;
      // A brand-new diagram id can't have an active share link yet (POST
      // never mints one), so skip the lookup. update_diagram / get_diagram
      // still call it because the diagram may have been shared since.
      const lines = [`Created: ${diagram.id}`, client.diagramUrl(diagram.id)];
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
        "When rewriting the source, keep or restore `class` assignments using the role names from this server's instructions so the diagram stays color-grouped." +
        " In a workspace with proposal review enabled, your change is recorded as a " +
        "proposal pending human approval rather than applied to the live diagram — " +
        "in that case tell the user you've proposed the change and share the review URL.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Diagram UUID" },
          title: { type: "string", description: "Display name" },
          code: { type: "string", description: "Mermaid source. Replaces the diagram's current code." },
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
      const res = await client.update(id, body);
      if (res.status === "proposed") {
        return {
          content: [{
            type: "text",
            text:
              "Change proposed — NOT applied yet. This workspace requires human " +
              "approval before an agent's diagram changes go live. A reviewer must " +
              "approve it here:\n" +
              client.diagramUrl(id) +
              "\n(Proposal id: " + (res.proposalId ?? "") + ")",
          }],
        };
      }
      const diagramId = res.diagram?.id ?? id;
      const lines = [`Updated: ${diagramId}`];
      if (res.versionId) lines.push(`Snapshot: ${res.versionId}`);
      lines.push(client.diagramUrl(diagramId));
      const shareUrl = await client.getActiveShareUrl(diagramId);
      if (shareUrl) lines.push(`Share: ${shareUrl}`);
      if (res.warnings && res.warnings.length) {
        lines.push("", "Warnings:", ...res.warnings.map((w) => `- ${w}`));
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "analyze_diagram",
    {
      description:
        "Analyze a stored flowchart diagram's structure (nodes, edges, subgraphs) and return actionable findings — orphan nodes, over-connected hubs, cycles, disconnected clusters, and grouping suggestions. Flowchart diagrams only. " +
        "Set postAsComments: true to also persist each finding as a comment on the diagram (node-pinned where the finding names a single node) so a human reviewer sees them on the diagram surface.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Diagram UUID" },
          postAsComments: {
            type: "boolean",
            description:
              "If true, persist each finding as a comment on the diagram instead of only returning ephemeral prose.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const id = String(args.id ?? "");
      if (!id) throw new Error("id is required");
      const opts = typeof args.postAsComments === "boolean" ? { postAsComments: args.postAsComments } : undefined;
      const { text } = await client.analyze(id, opts);
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
      const lines = items.map((v) => {
        const row = `${v.id}  ${v.label ?? "(no label)"}  ${v.title}  (${v.createdAt})`;
        const agent = agentTokenName(v.actor);
        return agent ? `${row}  (agent: ${agent})` : row;
      });
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

  server.registerTool(
    "list_comments",
    {
      description:
        "List comments on a diagram, oldest first. Returns id, parentId (null for a top-level comment), nodeId (the pinned node, if any), author, resolved state, and a body snippet. Use nodeId to fetch only the thread pinned to one node.",
      inputSchema: {
        type: "object",
        properties: {
          diagramId: { type: "string", description: "Diagram UUID" },
          nodeId: { type: "string", description: "Only comments pinned to this node id" },
          includeResolved: { type: "boolean", description: "Include resolved threads (default true)" },
          limit: { type: "number", description: "Max items (default 500, max 500)" },
          offset: { type: "number", description: "Items to skip (default 0)" },
        },
        required: ["diagramId"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const diagramId = String(args.diagramId ?? "");
      if (!diagramId) throw new Error("diagramId is required");
      const params: { nodeId?: string; includeResolved?: boolean; limit?: number; offset?: number } = {};
      if (typeof args.nodeId === "string") params.nodeId = args.nodeId;
      if (typeof args.includeResolved === "boolean") params.includeResolved = args.includeResolved;
      if (typeof args.limit === "number") params.limit = args.limit;
      if (typeof args.offset === "number") params.offset = args.offset;
      const { items, total } = await client.listComments(diagramId, params);
      const lines = items.map((c) => {
        const kind = c.parentId ? "  ↳ reply" : c.nodeId ? `  @${c.nodeId}` : "  (diagram)";
        const flag = c.resolvedAt ? " [resolved]" : "";
        const snippet = c.body ? (c.body.length > 60 ? `${c.body.slice(0, 60)}…` : c.body) : "[deleted]";
        return `${c.id}${kind}${flag}  ${c.authorName ?? c.authorId}: ${snippet}`;
      });
      const summary = `${items.length} of ${total} comment${total === 1 ? "" : "s"}`;
      return { content: [{ type: "text", text: [summary, ...lines].join("\n") }] };
    },
  );

  server.registerTool(
    "add_comment",
    {
      description:
        "Post a comment on a diagram. Pass nodeId to pin it to a specific node, or parentId to reply to an existing top-level comment (threads are one level deep). The author is the API token's owner. Use this to leave structured review findings a human will see on the diagram.",
      inputSchema: {
        type: "object",
        properties: {
          diagramId: { type: "string", description: "Diagram UUID" },
          body: { type: "string", description: "Comment text (1–5000 chars)" },
          nodeId: { type: "string", description: "Pin to this node id (top-level comments only)" },
          parentId: { type: "string", description: "Reply to this top-level comment id" },
        },
        required: ["diagramId", "body"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const diagramId = String(args.diagramId ?? "");
      const text = String(args.body ?? "");
      if (!diagramId || !text) throw new Error("diagramId and body are required");
      const payload: { body: string; nodeId?: string; parentId?: string } = { body: text };
      if (typeof args.nodeId === "string") payload.nodeId = args.nodeId;
      if (typeof args.parentId === "string") payload.parentId = args.parentId;
      const { comment } = await client.addComment(diagramId, payload);
      return { content: [{ type: "text", text: `Added: ${comment.id}\n${client.diagramUrl(diagramId)}` }] };
    },
  );

  server.registerTool(
    "list_decks",
    {
      description:
        "List presentation decks in the configured Space, newest-edited first. A deck is an ordered set of existing diagrams shown as a slideshow. Returns each deck's id, title, and slide count.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => {
      const { decks } = await client.listDecks();
      if (decks.length === 0) {
        return { content: [{ type: "text", text: "(no decks yet)" }] };
      }
      const lines = decks.map(
        (d) => `${d.id}  ${d.title}  (${d.slideCount} slide${d.slideCount === 1 ? "" : "s"})`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "get_deck",
    {
      description:
        "Fetch one deck by id. Returns its title, description, and the ordered list of slides (each slide is a diagram id + title in presentation order).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Deck UUID" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const id = String(args.id ?? "");
      if (!id) throw new Error("id is required");
      const { deck, slides } = await client.getDeck(id);
      const sections = [`# ${deck.title}`];
      if (deck.description) sections.push(`> ${deck.description}`);
      const slideLines = slides.length
        ? slides.map((s, i) => `${i + 1}. ${s.diagramId}  ${s.title}`).join("\n")
        : "(no slides yet)";
      sections.push(slideLines, `---\nPresent: ${client.deckUrl(deck.id)}`);
      return { content: [{ type: "text", text: sections.join("\n\n") }] };
    },
  );

  server.registerTool(
    "create_deck",
    {
      description:
        "Create a presentation deck from existing diagrams. Pass `slides` as the complete ordered list of diagram ids — the deck plays them as a slideshow in that order. Typical flow: create_diagram for each slide, collect the returned ids, then create_deck with those ids in presentation order. Returns the deck id and the present URL to share. Diagram ids must already exist in this Space (use list_diagrams to find them).",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Deck title shown in the deck list and above the presentation." },
          description: {
            type: "string",
            description: "Optional one-line summary of what the deck covers (≤1000 chars).",
          },
          slides: {
            type: "array",
            items: { type: "string" },
            description:
              "Ordered list of existing diagram UUIDs. The deck plays them in this exact order. A diagram may appear at most once. Omit or pass [] to create an empty deck.",
          },
        },
        additionalProperties: false,
      },
    },
    async (args) => {
      const body: { title?: string; description?: string | null; slides?: string[] } = {};
      if (typeof args.title === "string") body.title = args.title;
      if (typeof args.description === "string") body.description = args.description;
      if (Array.isArray(args.slides)) {
        body.slides = args.slides.filter((s): s is string => typeof s === "string");
      }
      const { deck } = await client.createDeck(body);
      return {
        content: [{ type: "text", text: [`Created deck: ${deck.id}`, client.deckUrl(deck.id)].join("\n") }],
      };
    },
  );

  server.registerTool(
    "update_deck",
    {
      description:
        "Update a deck's title, description, and/or slide order. `slides` is DECLARATIVE: pass the complete desired ordered list of diagram ids — reorder, add, and remove are all expressed by sending the new full list (any id omitted is removed from the deck; new ids are appended in the order given). Returns the deck id and present URL.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Deck UUID" },
          title: { type: "string", description: "Deck title shown in the deck list and above the presentation." },
          description: { type: "string", description: "One-line summary of what the deck covers (≤1000 chars)." },
          slides: {
            type: "array",
            items: { type: "string" },
            description:
              "Complete ordered list of diagram UUIDs that should be in the deck after this update. Omit to leave the slides unchanged; pass [] to clear all slides.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const id = String(args.id ?? "");
      if (!id) throw new Error("id is required");
      const body: { title?: string; description?: string | null; slides?: string[] } = {};
      if (typeof args.title === "string") body.title = args.title;
      if (typeof args.description === "string") body.description = args.description;
      if (Array.isArray(args.slides)) {
        body.slides = args.slides.filter((s): s is string => typeof s === "string");
      }
      if (body.title === undefined && body.description === undefined && body.slides === undefined) {
        throw new Error("Provide at least one of title, description, or slides.");
      }
      const { deck } = await client.updateDeck(id, body);
      return {
        content: [{ type: "text", text: [`Updated deck: ${deck.id}`, client.deckUrl(deck.id)].join("\n") }],
      };
    },
  );
}
