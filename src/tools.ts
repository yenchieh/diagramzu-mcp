import type { Actor, DiagramzuClient } from "./client.js";
import { describeSpaces, resolveSpace } from "./spaceResolver.js";

// ── card 160: the per-call `space` argument ──────────────────────────────────

/**
 * The `space` property, identical on every Space-scoped tool.
 *
 * ONE constant rather than fourteen copies: an agent reads these descriptions
 * once and acts on them for a whole session, so a tool whose wording had
 * drifted would be a tool whose rules it believes are different.
 *
 * NO NUMBERS in this text, deliberately — apps/web/tests/unit/
 * mcpStatedLimits.test.ts (card 127) requires every number stated in a schema
 * description to be accounted for against a Go constant, and there is no cap
 * here to account for.
 */
const SPACE_ARG = {
  type: "string",
  description:
    "Which workspace to act in: its id, its slug, or its exact name (case-insensitive). " +
    "Omit to use this token's default workspace. Call list_spaces to see what this token can reach. " +
    "A name that matches more than one workspace is refused — pass the id or slug instead.",
};

/** Adds the optional `space` property to a tool's property map. */
function withSpace(props: Record<string, unknown>): Record<string, unknown> {
  return { ...props, space: SPACE_ARG };
}

/**
 * Pick the client a handler should use, from its `space` argument.
 *
 * CALL BUDGET (card 160). `whoami` is the ONE go-api call mcp-svc makes per
 * request, and it already carries the default workspace, its name and the
 * token's scope — so a call that OMITS `space` costs nothing extra here. Only
 * a call that actually names a workspace pays for `/api/token/spaces`, at most
 * once, and the result is never cached beyond that call: membership is live,
 * and a cached listing keeps offering a workspace the holder was removed from.
 *
 * A failure to resolve THROWS. Unlike a flaky share lookup (card 136, which
 * fails open because the question was incidental), an unresolvable `space`
 * means we do not know where the agent wanted to act — and guessing is how a
 * write lands in someone else's workspace.
 */
async function scoped(
  client: DiagramzuClient,
  args: Record<string, unknown>,
): Promise<DiagramzuClient> {
  // Trimmed BEFORE the omitted check so "" and "   " read the same way. The
  // untrimmed version sent whitespace to the resolver, which paid for a
  // /api/token/spaces call to produce an error — same verdict, one wasted
  // round trip, and two spellings of "nothing".
  const raw = typeof args.space === "string" ? args.space.trim() : args.space;
  if (raw === undefined || raw === null || raw === "") {
    // THE D3 CELL: an account-scoped token whose DEFAULT workspace it has
    // lost, while others are still reachable. go-api deliberately keeps
    // whoami at 200 there so the token stays usable — but a call with no
    // `space` has nowhere to go, and saying so beats a bare 401 from the API.
    // `=== false`, not `!`: the flag is an EXCEPTION marker. A client that
    // does not carry it at all (an older go-api, or an in-process host that
    // builds its own) has told us nothing, and "nothing" must read as the
    // ordinary case — otherwise every such caller is refused on every call.
    if (client.defaultReachable === false) {
      throw new Error(
        "This token's default workspace is no longer reachable (you may have been removed from it, " +
          "or it was deleted). Call list_spaces and pass `space` explicitly.",
      );
    }
    return client;
  }
  if (typeof raw !== "string") {
    throw new Error("`space` must be a string: a workspace id, slug, or exact name.");
  }
  const spaces = await client.listSpaces();
  const res = resolveSpace(raw, spaces);
  if (!res.ok) throw new Error(res.error);
  return client.inSpace(res.space);
}

/**
 * Append the acting workspace to a tool result.
 *
 * Every result says where it happened, because with an account-scoped token
 * the answer is no longer a constant the agent can assume — and "Created: …"
 * with no workspace named is how a diagram ends up somewhere nobody looks.
 */
function inSpace(text: string, c: DiagramzuClient): string {
  return `${text}\n\n(in space ${c.spaceLabel})`;
}

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
    "list_spaces",
    {
      description:
        "List every workspace this connection can act in. Returns each workspace's id, slug, name, your role, " +
        "and which one is the default (the workspace used when a tool is called without `space`). " +
        "Call this FIRST when the user mentions a workspace by name, or when you are not sure which workspace " +
        "the work belongs in — then pass the id as `space` on the tool you actually want. " +
        "A connection scoped to a single workspace returns just that one.",
      // No `space` property: this is the tool that spans workspaces, so there
      // is nothing for it to be scoped to.
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => {
      const spaces = await client.listSpaces();
      // An empty list cannot happen through go-api (zero reachable workspaces
      // is a 401, so the request never reaches a tool), but a hand-rolled host
      // could produce one and "(none)" beats an empty response.
      const body = describeSpaces(spaces);
      const scopeLine =
        client.scope === "account"
          ? "This connection is scoped to ALL your workspaces, so `space` may name any of the above."
          : "This connection is scoped to ONE workspace. `space` can only name that workspace.";
      const defaultLine = client.defaultReachable
        ? ""
        : "\nNOTE: the default workspace is no longer reachable — pass `space` on every call.";
      return {
        content: [{ type: "text", text: `${body}\n\n${scopeLine}${defaultLine}` }],
      };
    },
  );

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
        properties: withSpace({
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
        }),
        additionalProperties: false,
      },
    },
    async (args) => {
      const c = await scoped(client, args);
      const params: { q?: string; owner?: string; sort?: "created" | "updated" | "title" | "relevance"; folderId?: string } = {};
      if (typeof args.q === "string") params.q = args.q;
      if (typeof args.owner === "string") params.owner = args.owner;
      // This tool documents `created` as its default (newest-first by creation).
      // Send it EXPLICITLY rather than relying on the REST default: card 82
      // changed the server's unspecified-sort default from created_at DESC to
      // updated_at DESC to match what the SPA labels its rows, and agent-facing
      // behaviour must not move with it.
      if (args.sort === "created" || args.sort === "updated" || args.sort === "title" || args.sort === "relevance") {
        params.sort = args.sort;
      } else {
        params.sort = "created";
      }
      if (typeof args.folderId === "string") params.folderId = args.folderId;
      const { diagrams } = await c.list(params);
      const lines = diagrams.map((d) => `${d.id}  ${d.title}  (updated ${d.updatedAt})`);
      return {
        content: [
          { type: "text", text: inSpace(lines.length ? lines.join("\n") : "(no diagrams yet)", c) },
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
      inputSchema: { type: "object", properties: withSpace({}), additionalProperties: false },
    },
    async (args) => {
      const c = await scoped(client, args);
      const { folders } = await c.listFolders();
      if (folders.length === 0) {
        return { content: [{ type: "text", text: inSpace("(no folders yet)", c) }] };
      }
      const byId = new Map(folders.map((f) => [f.id, f]));
      const lines = folders.map((f) => {
        if (f.parentId === null) return `${f.id}  ${f.name}`;
        const parent = byId.get(f.parentId);
        return parent ? `${f.id}  ${parent.name}/${f.name}` : `${f.id}  ${f.name}`;
      });
      return { content: [{ type: "text", text: inSpace(lines.join("\n"), c) }] };
    },
  );

  server.registerTool(
    "get_diagram",
    {
      description:
        "Fetch one diagram by id. Returns its title, description (the agent's brief), mermaid source code, and its URL in the app — which only members of this Space can open. " +
        "If the diagram already has a public link, that link is reported separately on a `Share (public, read-only):` line; a public link is minted by a person, from the diagram's Share button. " +
        "Read the description before editing — it tells you what the diagram is for and when to update it.",
      inputSchema: {
        type: "object",
        properties: withSpace({ id: { type: "string", description: "Diagram UUID" } }),
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const c = await scoped(client, args);
      const id = String(args.id ?? "");
      if (!id) throw new Error("id is required");
      const { diagram } = await c.get(id);
      const url = c.diagramUrl(diagram.id);
      const share = await c.lookupActiveShare(diagram.id);
      const sections = [`# ${diagram.title}`];
      if (diagram.description) sections.push(`> ${diagram.description}`);
      const agentLine = agentTokenLine(diagram.updatedActor);
      if (agentLine) sections.push(agentLine);
      // THREE states (fold 2, M1). The negative sentence is printed ONLY when the
      // API actually said `link: null`. When the lookup failed we say so instead
      // of asserting the diagram is private — a lookup that 500s while a live
      // link exists used to print "No public link yet".
      const shareLine =
        share.state === "link"
          ? `Share (public, read-only): ${share.url}`
          : share.state === "none"
            ? "No public link yet — someone in the Space mints one from the diagram's Share button."
            : "Couldn't check for a public link just now — this says nothing about whether one exists.";
      const footer = `---\nOpen (space members only): ${url}\n${shareLine}`;
      sections.push(diagram.code, footer);
      return {
        content: [{ type: "text", text: inSpace(sections.join("\n\n"), c) }],
      };
    },
  );

  server.registerTool(
    "create_diagram",
    {
      description:
        "Create a new diagram in the Space. Returns its id and its URL in the app, which only members of this Space can open — it is NOT a shareable link. " +
        "To show the diagram to anyone outside the Space, someone in the Space opens it in DiagramZu and uses its Share button, which mints a public read-only link. " +
        "See this server's instructions for diagram-type selection and `class` role names (`edge`/`core`/`data`/`accent`/`muted`) for color-grouping.",
      inputSchema: {
        type: "object",
        properties: withSpace({
          title: { type: "string", description: "Display name (≤200 chars)" },
          code: { type: "string", description: "Mermaid source (≤50,000 bytes). Defaults to a tiny flowchart." },
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
        }),
        additionalProperties: false,
      },
    },
    async (args) => {
      const c = await scoped(client, args);
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
      let created: Awaited<ReturnType<typeof c.create>>;
      try {
        created = await c.create(body);
      } catch (e) {
        const refusal = createRefusal(e, `${c.siteBaseUrl}/app/settings/plan`);
        if (refusal) return { content: [{ type: "text", text: inSpace(refusal, c) }] };
        throw e;
      }
      const { diagram, warnings } = created;
      // A brand-new diagram id can't have an active share link yet (POST
      // never mints one), so skip the lookup. update_diagram / get_diagram
      // still call it because the diagram may have been shared since.
      // LABEL THE URL IN THE OUTPUT, not only in the description (card 130). The
      // description is read once when the tool list loads; THIS line is what gets
      // pasted to a human, and an unlabelled /app/d URL is exactly the link that
      // bounces them to sign-in.
      const lines = [
        `Created: ${diagram.id}`,
        `Open (space members only): ${c.diagramUrl(diagram.id)}`,
      ];
      if (warnings && warnings.length) {
        lines.push("", "Warnings:", ...warnings.map((w) => `- ${w}`));
      }
      return {
        content: [{ type: "text", text: inSpace(lines.join("\n"), c) }],
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
        properties: withSpace({
          id: { type: "string", description: "Diagram UUID" },
          title: { type: "string", description: "Display name (≤200 chars)" },
          code: { type: "string", description: "Mermaid source (≤50,000 bytes). Replaces the diagram's current code." },
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
        }),
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const c = await scoped(client, args);
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
      const res = await c.update(id, body);
      if (res.status === "proposed") {
        return {
          content: [{
            type: "text",
            text: inSpace(
              "Change proposed — NOT applied yet. This workspace requires human " +
              "approval before an agent's diagram changes go live. A reviewer must " +
              "approve it here:\n" +
              // fold 2, S3: labelled like every other URL this server prints.
              `Open (space members only): ${c.diagramUrl(id)}` +
              "\n(Proposal id: " + (res.proposalId ?? "") + ")",
              c,
            ),
          }],
        };
      }
      const diagramId = res.diagram?.id ?? id;
      const lines = [`Updated: ${diagramId}`];
      if (res.versionId) lines.push(`Snapshot: ${res.versionId}`);
      lines.push(`Open (space members only): ${c.diagramUrl(diagramId)}`);
      // Same three-state lookup. This tool has never printed a NEGATIVE line, so
      // `none` and `unknown` both print nothing — it asserts only what it knows.
      const share = await c.lookupActiveShare(diagramId);
      if (share.state === "link") lines.push(`Share (public, read-only): ${share.url}`);
      if (res.warnings && res.warnings.length) {
        lines.push("", "Warnings:", ...res.warnings.map((w) => `- ${w}`));
      }
      return { content: [{ type: "text", text: inSpace(lines.join("\n"), c) }] };
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
        properties: withSpace({
          id: { type: "string", description: "Diagram UUID" },
          postAsComments: {
            type: "boolean",
            description:
              "If true, persist each finding as a comment on the diagram instead of only returning ephemeral prose.",
          },
        }),
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const c = await scoped(client, args);
      const id = String(args.id ?? "");
      if (!id) throw new Error("id is required");
      const opts = typeof args.postAsComments === "boolean" ? { postAsComments: args.postAsComments } : undefined;
      const { text } = await c.analyze(id, opts);
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
        properties: withSpace({
          diagramId: { type: "string", description: "Diagram UUID" },
          limit: { type: "number", description: "Max items to return (default 100, max 200)" },
          offset: { type: "number", description: "Items to skip (default 0)" },
        }),
        required: ["diagramId"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const c = await scoped(client, args);
      const diagramId = String(args.diagramId ?? "");
      if (!diagramId) throw new Error("diagramId is required");
      const params: { limit?: number; offset?: number } = {};
      if (typeof args.limit === "number") params.limit = args.limit;
      if (typeof args.offset === "number") params.offset = args.offset;
      const { items, total } = await c.listVersions(diagramId, params);
      const lines = items.map((v) => {
        const row = `${v.id}  ${v.label ?? "(no label)"}  ${v.title}  (${v.createdAt})`;
        const agent = agentTokenName(v.actor);
        return agent ? `${row}  (agent: ${agent})` : row;
      });
      const summary = `${items.length} of ${total} version${total === 1 ? "" : "s"}`;
      return {
        content: [{ type: "text", text: inSpace([summary, ...lines].join("\n"), c) }],
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
        properties: withSpace({
          diagramId: { type: "string", description: "Diagram UUID" },
          versionId: { type: "string", description: "Version UUID" },
        }),
        required: ["diagramId", "versionId"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const c = await scoped(client, args);
      const diagramId = String(args.diagramId ?? "");
      const versionId = String(args.versionId ?? "");
      if (!diagramId || !versionId) throw new Error("diagramId and versionId are required");
      const { version } = await c.getVersion(diagramId, versionId);
      const header = `# ${version.title}` +
        (version.label ? ` (${version.label})` : "") +
        `\n_Created ${version.createdAt} by ${version.createdBy}_`;
      return {
        content: [{ type: "text", text: inSpace(`${header}\n\n${version.code}`, c) }],
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
        properties: withSpace({
          diagramId: { type: "string", description: "Diagram UUID" },
          nodeId: { type: "string", description: "Only comments pinned to this node id" },
          includeResolved: { type: "boolean", description: "Include resolved threads (default true)" },
          limit: { type: "number", description: "Max items (default 500, max 500)" },
          offset: { type: "number", description: "Items to skip (default 0)" },
        }),
        required: ["diagramId"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const c = await scoped(client, args);
      const diagramId = String(args.diagramId ?? "");
      if (!diagramId) throw new Error("diagramId is required");
      const params: { nodeId?: string; includeResolved?: boolean; limit?: number; offset?: number } = {};
      if (typeof args.nodeId === "string") params.nodeId = args.nodeId;
      if (typeof args.includeResolved === "boolean") params.includeResolved = args.includeResolved;
      if (typeof args.limit === "number") params.limit = args.limit;
      if (typeof args.offset === "number") params.offset = args.offset;
      const { items, total } = await c.listComments(diagramId, params);
      const lines = items.map((c) => {
        const kind = c.parentId ? "  ↳ reply" : c.nodeId ? `  @${c.nodeId}` : "  (diagram)";
        const flag = c.resolvedAt ? " [resolved]" : "";
        const snippet = c.body ? (c.body.length > 60 ? `${c.body.slice(0, 60)}…` : c.body) : "[deleted]";
        return `${c.id}${kind}${flag}  ${c.authorName ?? c.authorId}: ${snippet}`;
      });
      const summary = `${items.length} of ${total} comment${total === 1 ? "" : "s"}`;
      return { content: [{ type: "text", text: inSpace([summary, ...lines].join("\n"), c) }] };
    },
  );

  server.registerTool(
    "add_comment",
    {
      description:
        "Post a comment on a diagram. Pass nodeId to pin it to a specific node, or parentId to reply to an existing top-level comment (threads are one level deep). The author is the API token's owner. Use this to leave structured review findings a human will see on the diagram.",
      inputSchema: {
        type: "object",
        properties: withSpace({
          diagramId: { type: "string", description: "Diagram UUID" },
          body: { type: "string", description: "Comment text (1–5000 chars)" },
          nodeId: { type: "string", description: "Pin to this node id (top-level comments only)" },
          parentId: { type: "string", description: "Reply to this top-level comment id" },
        }),
        required: ["diagramId", "body"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const c = await scoped(client, args);
      const diagramId = String(args.diagramId ?? "");
      const text = String(args.body ?? "");
      if (!diagramId || !text) throw new Error("diagramId and body are required");
      const payload: { body: string; nodeId?: string; parentId?: string } = { body: text };
      if (typeof args.nodeId === "string") payload.nodeId = args.nodeId;
      if (typeof args.parentId === "string") payload.parentId = args.parentId;
      const { comment } = await c.addComment(diagramId, payload);
      return {
        content: [{
          type: "text",
          text: inSpace(`Added: ${comment.id}\nOpen (space members only): ${c.diagramUrl(diagramId)}`, c),
        }],
      };
    },
  );

  server.registerTool(
    "list_decks",
    {
      description:
        "List presentation decks in the configured Space, newest-edited first. A deck is an ordered set of existing diagrams shown as a slideshow. Returns each deck's id, title, and slide count.",
      inputSchema: { type: "object", properties: withSpace({}), additionalProperties: false },
    },
    async (args) => {
      const c = await scoped(client, args);
      const { decks } = await c.listDecks();
      if (decks.length === 0) {
        return { content: [{ type: "text", text: inSpace("(no decks yet)", c) }] };
      }
      const lines = decks.map(
        (d) => `${d.id}  ${d.title}  (${d.slideCount} slide${d.slideCount === 1 ? "" : "s"})`,
      );
      return { content: [{ type: "text", text: inSpace(lines.join("\n"), c) }] };
    },
  );

  server.registerTool(
    "get_deck",
    {
      description:
        "Fetch one deck by id. Returns its title, description, and the ordered list of slides (each slide is a diagram id + title in presentation order).",
      inputSchema: {
        type: "object",
        properties: withSpace({ id: { type: "string", description: "Deck UUID" } }),
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const c = await scoped(client, args);
      const id = String(args.id ?? "");
      if (!id) throw new Error("id is required");
      const { deck, slides } = await c.getDeck(id);
      const sections = [`# ${deck.title}`];
      if (deck.description) sections.push(`> ${deck.description}`);
      const slideLines = slides.length
        ? slides.map((s, i) => `${i + 1}. ${s.diagramId}  ${s.title}`).join("\n")
        : "(no slides yet)";
      sections.push(
        slideLines,
        `---\nPresent (space members only): ${c.deckUrl(deck.id)}\nTo share outside the Space, open the deck and use its Share button to mint a public link.`,
      );
      return { content: [{ type: "text", text: inSpace(sections.join("\n\n"), c) }] };
    },
  );

  server.registerTool(
    "create_deck",
    {
      description:
        "Create a presentation deck from existing diagrams. Pass `slides` as the complete ordered list of diagram ids — the deck plays them as a slideshow in that order. Typical flow: create_diagram for each slide, collect the returned ids, then create_deck with those ids in presentation order. Returns the deck id and the present URL, which only members of this Space can open — it is NOT a shareable link. To share the deck outside the Space, someone in the Space opens it in DiagramZu and uses its Share button, which mints a public read-only presentation link. Diagram ids must already exist in this Space (use list_diagrams to find them).",
      inputSchema: {
        type: "object",
        properties: withSpace({
          title: { type: "string", description: "Deck title shown in the deck list and above the presentation (≤200 chars)." },
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
        }),
        additionalProperties: false,
      },
    },
    async (args) => {
      const c = await scoped(client, args);
      const body: { title?: string; description?: string | null; slides?: string[] } = {};
      if (typeof args.title === "string") body.title = args.title;
      if (typeof args.description === "string") body.description = args.description;
      if (Array.isArray(args.slides)) {
        body.slides = args.slides.filter((s): s is string => typeof s === "string");
      }
      const { deck } = await c.createDeck(body);
      return {
        content: [{ type: "text", text: inSpace([
          `Created deck: ${deck.id}`,
          // LABEL the URL in the OUTPUT, not only in the description. The
          // description is read once when the tool list loads; this line is what
          // gets pasted to a human, and an unlabelled /app/present URL is exactly
          // the link that bounces them to sign-in (card 130).
          `Present (space members only): ${c.deckUrl(deck.id)}`,
          "To share it outside the Space, open the deck in DiagramZu and use its Share button — that mints a public read-only link.",
        ].join("\n"), c) }],
      };
    },
  );

  server.registerTool(
    "update_deck",
    {
      description:
        "Update a deck's title, description, and/or slide order. `slides` is DECLARATIVE: pass the complete desired ordered list of diagram ids — reorder, add, and remove are all expressed by sending the new full list (any id omitted is removed from the deck; new ids are appended in the order given). Returns the deck id and the present URL, which only members of this Space can open — it is NOT a shareable link. To share the deck outside the Space, someone in the Space opens it in DiagramZu and uses its Share button, which mints a public read-only link.",
      inputSchema: {
        type: "object",
        properties: withSpace({
          id: { type: "string", description: "Deck UUID" },
          title: { type: "string", description: "Deck title shown in the deck list and above the presentation (≤200 chars)." },
          description: { type: "string", description: "One-line summary of what the deck covers (≤1000 chars)." },
          slides: {
            type: "array",
            items: { type: "string" },
            description:
              "Complete ordered list of diagram UUIDs that should be in the deck after this update. Omit to leave the slides unchanged; pass [] to clear all slides.",
          },
        }),
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const c = await scoped(client, args);
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
      const { deck } = await c.updateDeck(id, body);
      return {
        content: [{ type: "text", text: inSpace([
          `Updated deck: ${deck.id}`,
          `Present (space members only): ${c.deckUrl(deck.id)}`,
        ].join("\n"), c) }],
      };
    },
  );
}
