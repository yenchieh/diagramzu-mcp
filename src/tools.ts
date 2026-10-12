import type { Actor, DiagramzuClient, Page } from "./client.js";
import { DiagramzuApiError } from "./client.js";
import { applyPageEdits, pageOutline, pageSection, type PageEdit } from "./pageText.js";
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

  // THE D3 CELL: an account-scoped token whose DEFAULT workspace it has lost,
  // while others are still reachable. go-api deliberately keeps whoami at 200
  // there so the token stays usable — but a call that lands on the default has
  // nowhere to go, and saying so beats a bare 401 from the API.
  //
  // FOLD 2, F2 — THIS CHECK NOW COVERS BOTH WAYS OF LANDING ON THE DEFAULT:
  // omitting `space`, and naming the default's id EXPLICITLY. The S5
  // short-circuit below used to return the client before anything looked at
  // reachability, so an agent that spelled out the id — which is exactly what
  // SERVER_INSTRUCTIONS step 6 asks of it — got the bare 401 while an agent
  // that omitted the argument got the message. Same dead token, same remedy,
  // two different experiences depending on how explicit the agent was.
  //
  // `=== false`, not `!`: the flag is an EXCEPTION marker. A client that does
  // not carry it at all (an older go-api, or an in-process host that builds
  // its own) has told us nothing, and "nothing" must read as the ordinary
  // case — otherwise every such caller is refused on every call.
  const landsOnDefault =
    raw === undefined || raw === null || raw === "" || raw === client.spaceId;
  if (landsOnDefault && client.defaultReachable === false) {
    throw new Error(
      "This token's default workspace is no longer reachable (you may have been removed from it, " +
        "or it was deleted). Call list_spaces and pass `space` explicitly.",
    );
  }
  // CARD 161: the stdio server now starts even when its startup token check
  // failed, possibly with no default at all. Without this, the call below
  // would request `/api/spaces//…` and surface a bare 404.
  if (landsOnDefault && client.spaceId === "") {
    throw new Error(
      "This connection has no default workspace: the token check at startup failed (see the server log). " +
        "Fix DIAGRAMZU_BASE_URL / DIAGRAMZU_API_TOKEN and restart, set DIAGRAMZU_SPACE_ID, " +
        "or call list_spaces and pass `space` explicitly.",
    );
  }

  if (raw === undefined || raw === null || raw === "") {
    return client;
  }
  if (typeof raw !== "string") {
    throw new Error("`space` must be a string: a workspace id, slug, or exact name.");
  }
  // FOLD 1, S5 — an agent that passes `space` on EVERY call (the behaviour
  // SERVER_INSTRUCTIONS step 6 asks for when several workspaces are reachable)
  // paid for a /api/token/spaces round trip per tool call even when it named
  // the workspace we are already pointed at. Short-circuit that.
  //
  // THE ID ONLY, never the slug or the name. An id is unique by construction;
  // a NAME is not — two workspaces may both be called "Design", and skipping
  // the listing would resolve the ambiguous one silently instead of refusing
  // it, which is the single failure this resolver exists to prevent. The slug
  // is unique too, but the client is not told its own slug by whoami, so
  // there is nothing here to compare against.
  if (raw === client.spaceId) return client; // reachability settled above
  const spaces = await client.listSpaces();
  const res = resolveSpace(raw, spaces);
  if (!res.ok) throw new Error(res.error);
  return client.inSpace(res.space);
}

/**
 * Append the acting workspace to a tool result.
 *
 * FOLD 1, S7 — named `withSpaceFooter`, not `inSpace`. `client.inSpace(space)`
 * RETURNS A CLIENT pointed at another workspace; this formats a string. Two
 * things called `inSpace` in one file, one of them changing where a write
 * lands, is a confusion worth a longer name.
 *
 * Every result says where it happened, because with an account-scoped token
 * the answer is no longer a constant the agent can assume — and "Created: …"
 * with no workspace named is how a diagram ends up somewhere nobody looks.
 */
function withSpaceFooter(text: string, c: DiagramzuClient): string {
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

// ── card 164: the page refusals ───────────────────────────────────────────────
//
// Card 162 defined stable error tokens precisely so this mapper exists
// (pages_write.go: "The MCP error mapper (slice 3) … will MATCH these strings").
// Each one becomes a sentence an agent can act on, and every one of them says
// NOTHING WAS WRITTEN — an agent that is unsure whether its write landed either
// retries (a second write) or tells a human the work is saved when it is not.
//
// TWO SHAPES, and the split is a judgement call worth stating:
//
//   `refusal` — the WORKSPACE or the DEPLOYMENT said no: a cap, a review
//   workspace, the kill switch, a rate limit. Returned as TEXT with the
//   workspace footer, exactly as `createRefusal` does for the diagram cap
//   (card 136). Retrying differently cannot help; the agent needs a sentence to
//   relay to a person who can act.
//
//   `error` — the CALL was wrong, or the page moved under it: an invalid `lang`,
//   a stale `baseRevision`, a conflict that survived the one retry. THROWN, so
//   the client sees a tool error rather than prose it might read as a success.
//   D1(b)5 asks for exactly that on the second 409.
//
// Anything else returns null and the caller rethrows: a mapper that swallows
// every failure is how a 500 becomes a confident lie.
type PageFailure = { refusal: string } | { error: string } | null;

/** "268435456" → "256 MiB", for a sentence a human will read. */
function mib(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

function numberFrom(payload: Record<string, unknown> | undefined, key: string): number | null {
  const v = payload?.[key];
  return typeof v === "number" ? v : null;
}

/**
 * The CURRENT row a 409 carries (card 162's `writeRevisionConflict`), when it
 * carries one. This is what lets the `edits` retry re-apply against the new
 * body WITHOUT a second GET: the body and the revision come from the same
 * snapshot — the very state that refused the write — so there is no window
 * between reading the text and naming the revision it belongs to.
 */
function conflictCurrent(err: unknown): { body: string; revision: number } | null {
  if (!(err instanceof DiagramzuApiError) || err.status !== 409) return null;
  const cur = err.payload?.current;
  if (!cur || typeof cur !== "object") return null;
  const { body, revision } = cur as { body?: unknown; revision?: unknown };
  if (typeof body !== "string" || typeof revision !== "number") return null;
  return { body, revision };
}

/** The revision a 409 reports as current, for the error sentence. */
function conflictRevision(err: unknown): number | null {
  return conflictCurrent(err)?.revision ?? null;
}

const CONFLICT_ADVICE =
  "Call get_page to read the current text and the new revision, then re-apply your change.";

/**
 * How many times `update_page`'s `edits` mode may PATCH: the first write plus
 * ONE retry (D1(b)5). Named so the budget is a single token rather than a shape
 * of control flow, and so a change to it is visible in a diff.
 */
const PAGE_EDIT_ATTEMPTS = 2;

/**
 * The number of rows go-api's page list can return — `pageListLimit` in
 * services/go-api/internal/handlers/pages.go, which is a fixed `LIMIT 200` with
 * no cursor and no offset.
 *
 * Mirrored here ONLY to tell the agent when the list it is holding is full, so
 * "N pages" is never read as "the whole workspace". If the two ever drift, the
 * failure is a missing warning, never a wrong list — this number decides no
 * request and truncates nothing.
 */
const PAGE_LIST_CAP = 200;

function explainPageFailure(err: unknown): PageFailure {
  if (!(err instanceof DiagramzuApiError)) return null;
  const token = err.token;

  if (err.status === 503 && token === "pages_disabled") {
    return {
      refusal:
        "Pages are switched off in this DiagramZu deployment right now, so nothing was written. " +
        "Reading existing pages still works. Ask whoever runs this deployment to turn Pages back on.",
    };
  }
  if (err.status === 402 && token === "page_limit") {
    const limit = numberFrom(err.payload, "limit");
    return {
      refusal:
        `This workspace has reached its ceiling of ${(limit ?? 10000).toLocaleString("en-US")} pages, ` +
        "so no page was created. Existing pages are unaffected. Delete pages the team no longer needs, " +
        "then try again. (Paying does not raise this ceiling — it is the same on every plan.)",
    };
  }
  if (err.status === 402 && token === "page_storage_limit") {
    const limit = numberFrom(err.payload, "limit");
    const used = numberFrom(err.payload, "used");
    return {
      refusal:
        `This workspace has used its page storage budget of ${limit === null ? "256 MiB" : mib(limit)}` +
        `${used === null ? "" : ` (about ${mib(used)} in use)`}, so nothing was written. ` +
        "The budget counts page bodies AND every stored version of them, so a workspace at the cap " +
        "cannot be edited at all — not even to make a page shorter — until something is deleted. " +
        "Deleting a page frees its history too.",
    };
  }
  if (err.status === 403 && token === "page_review_unsupported") {
    return {
      refusal:
        "This workspace reviews agent changes, and a page edit cannot be proposed for review yet, " +
        "so nothing was written. Create a new page with your draft instead, or ask a workspace " +
        "member to apply the change.",
    };
  }
  if (err.status === 409 && token === "named_version_limit") {
    const limit = numberFrom(err.payload, "limit");
    return {
      refusal:
        `This page already has the maximum of ${limit ?? 50} named snapshots, so nothing was written — ` +
        "the snapshot you asked for could not be taken, and the edit was not applied without it. " +
        "Delete a snapshot in DiagramZu, or call update_page again without createVersion.",
    };
  }
  if (err.status === 429) {
    // FOLD 1 — NEUTRAL wording. This mapper serves the reads as well, and the
    // write-specific "so nothing was written" on a rate-limited get_page told
    // an agent its READ had failed to write something.
    return {
      refusal:
        "DiagramZu is rate-limiting page requests from this workspace for a moment, so this call " +
        "did nothing — nothing was read, and nothing was changed. Wait a few seconds and try again.",
    };
  }
  if (err.status === 409 && token === "revision_conflict") {
    const rev = conflictRevision(err);
    return {
      error:
        "Someone else changed this page" +
        (rev === null ? "" : ` (it is now revision ${rev})`) +
        `, so nothing was written. ${CONFLICT_ADVICE}`,
    };
  }
  if (err.status === 400 && /base_revision_required/.test(err.body)) {
    return {
      error:
        "A page's body write must say which revision it is based on, so nothing was written. " +
        "Call get_page and pass the revision it reports as `baseRevision`.",
    };
  }
  // FOLD 1, R4g — matched on go-api's exact token, not on the word appearing
  // anywhere in a 400. `decodePageWriteBody` answers literally "invalid lang"
  // (card 162); a different 400 that merely MENTIONS the field — an unknown-field
  // rejection, say — used to be explained as a malformed tag, which sends the
  // agent to fix something that is not wrong.
  if (err.status === 400 && /invalid lang/i.test(err.body)) {
    return {
      error:
        "`lang` must be a short language tag made of letters and hyphens — en, ja, zh-TW, pt-BR. " +
        "Nothing was written.",
    };
  }
  return null;
}

/**
 * The ONE wrapper every page tool's body runs inside.
 *
 * It does two things that must not be left to four copies: it appends the
 * workspace footer to EVERY outcome, success and refusal alike (card 160's
 * promise in SERVER_INSTRUCTIONS step 6, which `analyze_diagram` once broke),
 * and it applies the refusal/error split above. A validation error the handler
 * raises itself is not a `DiagramzuApiError`, so it passes straight through
 * with its own wording.
 */
async function pageResult(
  c: DiagramzuClient,
  run: () => Promise<string>,
  /**
   * FOLD 1, S1 — what a failure must ALSO say, decided when the failure
   * happens rather than up front.
   *
   * `update_page`'s `createVersion` takes a named snapshot BEFORE the write it
   * protects, so a refusal after that point is not "nothing happened": a row
   * was written and it spent one of the page's fifty named versions. Every
   * refusal said "nothing was written" regardless, so an agent reading it
   * would retry the identical call and burn another. The note comes from a
   * callback because only the handler knows whether the POST actually went out.
   */
  footnote?: () => string | null,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const annotate = (msg: string): string => {
    const extra = footnote?.();
    return extra ? `${msg}\n\n${extra}` : msg;
  };
  try {
    return { content: [{ type: "text", text: withSpaceFooter(await run(), c) }] };
  } catch (e) {
    const explained = explainPageFailure(e);
    if (explained && "refusal" in explained) {
      return { content: [{ type: "text", text: withSpaceFooter(annotate(explained.refusal), c) }] };
    }
    if (explained && "error" in explained) throw new Error(annotate(explained.error));
    // A validation error the handler raised itself — an unmatched edit, a bad
    // argument — is rethrown with its own wording, but it still has to carry
    // the snapshot note: the RETRY refusal is precisely the path that leaves a
    // snapshot behind.
    const extra = footnote?.();
    if (extra && e instanceof Error) throw new Error(annotate(e.message));
    throw e;
  }
}

/** `Open (space members only): …` — the only URL a page tool prints. */
function pageOpenLines(c: DiagramzuClient, id: string): string[] {
  return ["---", `Open (space members only): ${c.pageUrl(id)}`];
}

/** The one-line attribution a page's last write earns, or nothing. */
function pageActorLine(page: Pick<Page, "updatedActor">): string | null {
  const name = agentTokenName(page.updatedActor);
  return name ? `Last updated by agent token \`${name}\`` : null;
}

/** The `edits` argument, validated into PageEdits or refused. */
function parseEdits(raw: unknown): PageEdit[] {
  if (!Array.isArray(raw)) throw new Error("`edits` must be an array of {oldText, newText}.");
  if (raw.length === 0) {
    throw new Error(
      "`edits` is empty, so there is nothing to apply and nothing was written. Pass at least one " +
        "{oldText, newText}, or use baseRevision + body to replace the whole page.",
    );
  }
  return raw.map((e, i) => {
    const edit = e as { oldText?: unknown; newText?: unknown };
    if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") {
      throw new Error(
        `edits[${i}] must have string \`oldText\` and \`newText\`. Nothing was written.`,
      );
    }
    return { oldText: edit.oldText, newText: edit.newText };
  });
}

/**
 * Apply the edits or REFUSE, with the index and the count in the message.
 *
 * `where` distinguishes the first attempt from the retry, because the remedy
 * differs: on the first attempt the agent's `oldText` never matched the page it
 * just read, which is its own mistake to fix; on the RETRY the text matched a
 * moment ago and another writer has since changed that very span — the one case
 * where proceeding would destroy somebody else's edit.
 */
function applyEditsOrRefuse(body: string, edits: PageEdit[], where: "first" | "retry"): string {
  const res = applyPageEdits(body, edits);
  if (res.ok) return res.text;
  const tail =
    where === "retry"
      ? `The page changed under you; nothing was written. ${CONFLICT_ADVICE}`
      : "Nothing was written. Call get_page, copy the exact text you mean to replace " +
        "(including its surrounding lines if it is not unique), and try again.";
  if (res.reason === "empty") {
    throw new Error(`edits[${res.index}] has an empty \`oldText\`, which would match anywhere. ${tail}`);
  }
  if (res.reason === "noop") {
    // FOLD 1, R3a. REFUSED, not skipped: skipping it would let the other edits
    // through while the agent believed all of them applied, which is the quiet
    // half-write this mode exists to prevent.
    throw new Error(
      `edits[${res.index}]'s \`newText\` is identical to its \`oldText\`, so it changes nothing — ` +
        `but sending it would still write a new revision, move the page's last editor to you, and ` +
        `invalidate the baseRevision anybody else is holding. Drop that edit, or fix its newText. ` +
        `Nothing was written.`,
    );
  }
  throw new Error(
    `edits[${res.index}]'s \`oldText\` matched ${res.count} times in the page; it must match ` +
      `exactly once. ${tail}`,
  );
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
          { type: "text", text: withSpaceFooter(lines.length ? lines.join("\n") : "(no diagrams yet)", c) },
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
        return { content: [{ type: "text", text: withSpaceFooter("(no folders yet)", c) }] };
      }
      const byId = new Map(folders.map((f) => [f.id, f]));
      const lines = folders.map((f) => {
        if (f.parentId === null) return `${f.id}  ${f.name}`;
        const parent = byId.get(f.parentId);
        return parent ? `${f.id}  ${parent.name}/${f.name}` : `${f.id}  ${f.name}`;
      });
      return { content: [{ type: "text", text: withSpaceFooter(lines.join("\n"), c) }] };
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
        content: [{ type: "text", text: withSpaceFooter(sections.join("\n\n"), c) }],
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
        if (refusal) return { content: [{ type: "text", text: withSpaceFooter(refusal, c) }] };
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
        content: [{ type: "text", text: withSpaceFooter(lines.join("\n"), c) }],
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
            text: withSpaceFooter(
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
      return { content: [{ type: "text", text: withSpaceFooter(lines.join("\n"), c) }] };
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
      // FOLD 1, S3: this was the ONE return of nineteen that the footer sweep
      // missed, while SERVER_INSTRUCTIONS step 6 tells the agent every result
      // carries it. mcpSpaceFooter.test.ts now walks EVERY space-scoped tool
      // through registerTools and requires it, so the next tool cannot.
      return { content: [{ type: "text", text: withSpaceFooter(text, c) }] };
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
        content: [{ type: "text", text: withSpaceFooter([summary, ...lines].join("\n"), c) }],
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
        content: [{ type: "text", text: withSpaceFooter(`${header}\n\n${version.code}`, c) }],
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
      return { content: [{ type: "text", text: withSpaceFooter([summary, ...lines].join("\n"), c) }] };
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
          text: withSpaceFooter(`Added: ${comment.id}\nOpen (space members only): ${c.diagramUrl(diagramId)}`, c),
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
        return { content: [{ type: "text", text: withSpaceFooter("(no decks yet)", c) }] };
      }
      const lines = decks.map(
        (d) => `${d.id}  ${d.title}  (${d.slideCount} slide${d.slideCount === 1 ? "" : "s"})`,
      );
      return { content: [{ type: "text", text: withSpaceFooter(lines.join("\n"), c) }] };
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
      return { content: [{ type: "text", text: withSpaceFooter(sections.join("\n\n"), c) }] };
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
        content: [{ type: "text", text: withSpaceFooter([
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
        content: [{ type: "text", text: withSpaceFooter([
          `Updated deck: ${deck.id}`,
          `Present (space members only): ${c.deckUrl(deck.id)}`,
        ].join("\n"), c) }],
      };
    },
  );

  // ── card 164: Markdown pages ───────────────────────────────────────────────
  //
  // A page is where the PROSE of a decision lives — the trade-offs, the
  // rollout, the risks — with diagrams embedded in it by id. The four tools
  // below are deliberately shaped so an agent never has to hold a whole
  // document in context to change one paragraph: `get_page` can return an
  // outline or a single section, and `update_page`'s `edits` mode sends spans
  // rather than the document.

  server.registerTool(
    "list_pages",
    {
      description:
        "List the workspace's Markdown pages, most recently edited first. Returns each page's id, " +
        "title, revision, last-edit time, who edited it, and a short snippet — never the full body; " +
        "call get_page for that. Filter with `q`, a case-insensitive substring over title and body " +
        "that works in Chinese and Japanese too, and pass `sort: 'relevance'` with it so a title hit " +
        "ranks first. Call this BEFORE create_page to see whether a page on the topic already exists " +
        "— prefer update_page over writing a second one.",
      inputSchema: {
        type: "object",
        properties: withSpace({
          q: {
            type: "string",
            description:
              "Case-insensitive substring search over title and body. Works for CJK text; a query of one or two Chinese characters is slower because the trigram index cannot help it.",
          },
          folderId: {
            type: "string",
            description:
              "Optional UUID — narrow to pages in this folder. Use list_folders to look up folder ids. Omit to see every folder (the default).",
          },
          owner: {
            type: "string",
            description:
              "Filter to pages created by this user id. Rarely needed; omit unless the caller already has the id.",
          },
          sort: {
            type: "string",
            enum: ["created", "updated", "title", "relevance"],
            description:
              "Sort order. 'updated' (the default) = newest edit first; 'created' = newest page first; 'title' = alphabetical; 'relevance' = title hits before body hits, and only meaningful with `q`.",
          },
        }),
        additionalProperties: false,
      },
    },
    async (args) => {
      const c = await scoped(client, args);
      return pageResult(c, async () => {
        const params: {
          q?: string;
          folderId?: string;
          owner?: string;
          sort?: "created" | "updated" | "title" | "relevance";
        } = {};
        if (typeof args.q === "string") params.q = args.q;
        if (typeof args.folderId === "string") params.folderId = args.folderId;
        if (typeof args.owner === "string") params.owner = args.owner;
        if (
          args.sort === "created" ||
          args.sort === "updated" ||
          args.sort === "title" ||
          args.sort === "relevance"
        ) {
          params.sort = args.sort;
        }
        const { pages } = await c.listPages(params);
        if (!pages || pages.length === 0) {
          // FOLD 1, S2 — "(no pages yet)" under a FILTER told an agent the
          // workspace was empty when it had only failed to match. The next
          // move is opposite in the two cases: widen the search, or write the
          // first page. `all=true` is what the client sends when no folder is
          // named, so an unfiltered empty really is an empty workspace.
          const why: string[] = [];
          if (params.q !== undefined) why.push(`q "${params.q}"`);
          if (params.folderId !== undefined) why.push("that folder");
          if (params.owner !== undefined) why.push(`owner "${params.owner}"`);
          return why.length
            ? `No pages match ${why.join(" and ")}. (The workspace may still have pages — ` +
              `this is a filtered search, so widen or drop the filter before concluding it is empty.)`
            : "(no pages yet)";
        }
        const lines = pages.flatMap((p) => {
          const agent = agentTokenName(p.updatedActor);
          const head =
            `${p.id}  ${p.title}  (rev ${p.revision}, updated ${p.updatedAt})` +
            (agent ? `  (agent: ${agent})` : "");
          const snippet = p.snippet ? p.snippet.replace(/\s+/g, " ").trim() : "";
          return snippet ? [head, `    ${snippet}`] : [head];
        });
        const summary = `${pages.length} page${pages.length === 1 ? "" : "s"}`;
        // SAY SO WHEN THE LIST IS FULL. go-api's ListPages is a fixed
        // `LIMIT 200` with no cursor and no offset (pages.go#pageListLimit), so
        // a full page of results means "at least this many", not "this many" —
        // and this tool's own description tells an agent to call it BEFORE
        // create_page precisely to avoid a duplicate. An agent that read "200
        // pages" as the whole workspace and wrote a second copy of a page it
        // could not see would be acting correctly on a number we stated wrongly.
        const truncated = pages.length >= PAGE_LIST_CAP;
        return [
          truncated ? `${summary} (the most this list returns — there may be more)` : summary,
          ...lines,
          ...(truncated
            ? ["", "Narrow with `q` or `folderId` to see pages beyond this point."]
            : []),
        ].join("\n");
      });
    },
  );

  server.registerTool(
    "get_page",
    {
      description:
        "Fetch one Markdown page by id. Returns its body, its `revision` — pass that as " +
        "`baseRevision` when replacing the whole body — its language, who edited it last, and its " +
        "URL in the app, which only members of this workspace can open. To let somebody outside " +
        "the workspace read it, a person in the workspace opens the page in DiagramZu and uses " +
        "its Share button, which mints a public read-only link. For a long document prefer " +
        "`outline: true` (the heading tree, with an anchor per heading) and then " +
        "`section: '<heading text or anchor>'` for just the part you need.",
      inputSchema: {
        type: "object",
        properties: withSpace({
          id: { type: "string", description: "Page UUID" },
          outline: {
            type: "boolean",
            description:
              "Return only the heading tree — level, text and an anchor per heading — instead of the body. Use this first on a long page, then ask for one section.",
          },
          section: {
            type: "string",
            description:
              "Return only one section: a heading's exact text, or the anchor that `outline` printed for it. The section runs from that heading to the next heading of the same or a higher level, so sub-headings come with it. A heading text that fits more than one heading is refused — pass its anchor instead.",
          },
        }),
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const c = await scoped(client, args);
      return pageResult(c, async () => {
        const id = String(args.id ?? "");
        if (!id) throw new Error("id is required");
        const wantOutline = args.outline === true;
        const wantSection = typeof args.section === "string" && args.section.trim() !== "";
        if (wantOutline && wantSection) {
          throw new Error(
            "Pass `outline: true` OR `section`, not both: the first asks what the page contains, " +
              "the second asks for one part of it.",
          );
        }
        const { page } = await c.getPage(id);
        const open = pageOpenLines(c, page.id);

        if (wantOutline) {
          const headings = pageOutline(page.body);
          const tree = headings.length
            ? headings
                .map(
                  (h) =>
                    `${"  ".repeat(h.level - 1)}${"#".repeat(h.level)} ${h.text}  (anchor: ${h.anchor})`,
                )
                .join("\n")
            : "(no headings)";
          return [
            `# ${page.title} — outline`,
            `Revision: ${page.revision}`,
            "",
            tree,
            "",
            ...open,
          ].join("\n");
        }

        if (wantSection) {
          const selector = String(args.section).trim();
          const res = pageSection(page.body, selector);
          if (!res.ok) {
            const list = res.headings
              .map((h) => `${"#".repeat(h.level)} ${h.text} (anchor: ${h.anchor})`)
              .join("; ");
            throw new Error(
              res.reason === "ambiguous"
                ? `More than one heading in this page is called "${selector}". Pass one of these ` +
                  `anchors instead: ${list}`
                : `This page has no section matching "${selector}". Its headings are: ` +
                  `${list || "(none)"}. Pass a heading's exact text or its anchor.`,
            );
          }
          return [
            `# ${page.title} › ${res.heading.text}`,
            `Revision: ${page.revision}`,
            "",
            res.text,
            ...open,
          ].join("\n");
        }

        const head = [
          `# ${page.title}`,
          `Revision: ${page.revision}`,
          `Language: ${page.lang}`,
          `Updated: ${page.updatedAt}`,
        ];
        const actor = pageActorLine(page);
        if (actor) head.push(actor);
        return [...head, "", page.body, "", ...open].join("\n");
      });
    },
  );

  server.registerTool(
    "create_page",
    {
      description:
        "Create a Markdown page in the workspace — a design write-up, a decision record, a runbook, " +
        "the prose a diagram cannot carry. The title comes from the body (front-matter `title`, else " +
        "the first top-level `#` heading), so begin the body with a heading rather than passing " +
        "`title`. Embed a stored diagram by putting its id inside a fenced `diagramzu` block; an " +
        "inline `mermaid` block is for a throwaway sketch nobody will revisit. Returns the page's id, " +
        "its revision and its URL in the app, which only members of this workspace can open. To let " +
        "somebody outside the workspace read it, a person in the workspace opens the page in " +
        "DiagramZu and uses its Share button, which mints a public read-only link.",
      inputSchema: {
        type: "object",
        properties: withSpace({
          body: {
            type: "string",
            description:
              "The page's Markdown (≤100,000 chars, counted after line endings and Unicode are normalised — i.e. of the text you would read back).",
          },
          title: {
            type: "string",
            description:
              "Optional display name (≤200 chars). The BODY wins: front-matter `title` or a leading `#` heading overrides this, which is why writing the heading is the better habit.",
          },
          folderId: {
            type: "string",
            description:
              "Optional UUID of an existing folder to put the page in. Use list_folders to find one by name. Omit to place it at the workspace root.",
          },
          lang: {
            type: "string",
            description:
              "Optional language tag for the page's prose — en, ja, zh-TW, pt-BR. Letters and hyphens only. Omit to inherit front-matter `lang`, else your account's language.",
          },
        }),
        required: ["body"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const c = await scoped(client, args);
      return pageResult(c, async () => {
        if (typeof args.body !== "string" || args.body.trim() === "") {
          throw new Error(
            "`body` is required: a page is its Markdown. Start it with a `#` heading, which also " +
              "becomes the page's title.",
          );
        }
        const payload: { body: string; title?: string; folderId?: string; lang?: string } = {
          body: args.body,
        };
        if (typeof args.title === "string") payload.title = args.title;
        if (typeof args.folderId === "string") payload.folderId = args.folderId;
        if (typeof args.lang === "string") payload.lang = args.lang;
        const { page } = await c.createPage(payload);
        return [
          `Created page: ${page.id}`,
          `Title: ${page.title}`,
          `Revision: ${page.revision}`,
          ...pageOpenLines(c, page.id),
        ].join("\n");
      });
    },
  );

  server.registerTool(
    "update_page",
    {
      description:
        "Update a Markdown page. EXACTLY ONE body mode, and `edits` is the one to reach for: each " +
        "edit replaces an `oldText` that must appear exactly once in the page, so a change to one " +
        "paragraph never sends — or silently reverts — the rest of the document. If somebody else " +
        "edits the page first, YOUR edits are re-applied on top of THEIR text, and the call is " +
        "refused outright if they changed the very span you are editing. The other " +
        "mode is `baseRevision` plus `body`, which replaces the whole document and needs the " +
        "revision get_page reported. Changing only metadata (title, folderId, lang) needs neither. " +
        "Returns the page's new revision and its URL in the app, which only members of this " +
        "workspace can open. To let somebody outside the workspace read it, a person in the " +
        "workspace opens the page in DiagramZu and uses its Share button, which mints a public " +
        "read-only link.",
      inputSchema: {
        type: "object",
        properties: withSpace({
          id: { type: "string", description: "Page UUID" },
          edits: {
            type: "array",
            description:
              "Targeted replacements, applied in order. Each `oldText` must match exactly once in the page as it then stands — zero or several matches refuses the whole call and writes nothing, naming the edit that failed. Do not pass `baseRevision` with this: the server's revision is read and re-read for you.",
            items: {
              type: "object",
              properties: {
                oldText: {
                  type: "string",
                  description:
                    "The exact text to replace, copied from get_page. Include enough surrounding text to make it unique in the page.",
                },
                newText: { type: "string", description: "What to put in its place. May be empty to delete the span." },
              },
              required: ["oldText", "newText"],
              additionalProperties: false,
            },
          },
          baseRevision: {
            type: "number",
            description:
              "The revision the replacement body is based on, from get_page. Required with `body`, forbidden with `edits`. If the page moved on since, the write is refused rather than applied on top.",
          },
          body: {
            type: "string",
            description:
              "A complete replacement body (≤100,000 chars). Needs `baseRevision`. Prefer `edits` unless you are genuinely rewriting the whole document.",
          },
          title: {
            type: "string",
            description:
              "Rename the page (≤200 chars). Ignored while the body carries front-matter `title` or a leading `#` heading — rename by editing the heading instead.",
          },
          folderId: {
            type: "string",
            description: "Move the page into this folder (UUID). Use list_folders to look one up.",
          },
          lang: {
            type: "string",
            description:
              "Change the page's language tag — en, ja, zh-TW, pt-BR. Letters and hyphens only.",
          },
          createVersion: {
            type: "boolean",
            description:
              "If true, take a named snapshot of the page as it is now BEFORE applying the change, so a human can get the previous text back. Use it when you are rewriting substantially.",
          },
          versionLabel: {
            type: "string",
            description: "Optional label for that snapshot (max 80 chars).",
          },
        }),
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const c = await scoped(client, args);
      // Declared in the HANDLER's scope, not inside run(): the S1 footnote
      // below is a sibling of run(), and it has to be able to see whether the
      // snapshot POST actually went out.
      let snapshotId: string | undefined;
      return pageResult(c, async () => {
        const id = String(args.id ?? "");
        if (!id) throw new Error("id is required");

        const hasBody = typeof args.body === "string";
        const hasEdits = args.edits !== undefined && args.edits !== null;

        // FOLD 1, R2b — a `baseRevision` an agent stringified ("3") used to
        // fall through `typeof === "number"` and be reported as MISSING, which
        // sends it looking for the wrong bug. A whole-number string is
        // accepted; anything else that is present says what it must be.
        const baseRevisionGiven = args.baseRevision !== undefined && args.baseRevision !== null;
        let baseRevision: number | undefined;
        if (typeof args.baseRevision === "number") {
          baseRevision = args.baseRevision;
        } else if (typeof args.baseRevision === "string" && /^\d+$/.test(args.baseRevision.trim())) {
          baseRevision = Number(args.baseRevision.trim());
        } else if (baseRevisionGiven) {
          throw new Error(
            "`baseRevision` must be a number — the revision get_page reported, e.g. 3. Nothing was written.",
          );
        }
        const hasBase = baseRevision !== undefined;

        // THE MODE RULE, enforced here rather than in the schema: `buildServer`
        // hands `inputSchema` to the client untouched and never validates
        // `tools/call` arguments against it, so a `oneOf` would document the rule
        // to clients that happen to validate and enforce it on nobody. Both
        // field descriptions state it, and this is what makes it true.
        if (hasBody && hasEdits) {
          throw new Error(
            "Pass EXACTLY ONE body mode: `edits` for targeted replacements, or `baseRevision` plus " +
              "`body` to replace the whole page. Both were given, so nothing was written.",
          );
        }
        if (hasBody && !hasBase) {
          throw new Error(
            "Replacing the whole body needs `baseRevision`, the revision get_page reported, so that " +
              "a change somebody else made in the meantime is refused rather than overwritten. " +
              "Nothing was written.",
          );
        }
        if (hasEdits && hasBase) {
          throw new Error(
            "Do not pass `baseRevision` with `edits`: the edits mode reads the page's revision " +
              "itself, and re-reads it if another writer lands first. Nothing was written.",
          );
        }

        // Metadata rides along with either mode, or travels alone.
        const meta: { title?: string; folderId?: string; lang?: string } = {};
        if (typeof args.title === "string") meta.title = args.title;
        if (typeof args.folderId === "string") meta.folderId = args.folderId;
        if (typeof args.lang === "string") meta.lang = args.lang;

        if (!hasBody && !hasEdits && Object.keys(meta).length === 0) {
          throw new Error(
            "Nothing to update. Pass `edits`, or `baseRevision` + `body`, or at least one of " +
              "title, folderId or lang.",
          );
        }

        // FOLD 1, R2a — `baseRevision` with NEITHER body mode was accepted and
        // then dropped on the floor, so a metadata-only PATCH looked to the
        // agent like a guarded write and was not one: go-api neither checks nor
        // bumps `revision` for a title, folder or lang change (card 162). An
        // agent that believed otherwise would think it had been protected from
        // a concurrent edit it was never protected from.
        if (hasBase && !hasBody && !hasEdits) {
          throw new Error(
            "`baseRevision` only applies to a BODY write, and this call changes only metadata. " +
              "A title, folder or lang change never checks or bumps the page's revision, so there " +
              "is nothing for it to guard — drop it, or pass `body` with it. Nothing was written.",
          );
        }

        const label = typeof args.versionLabel === "string" ? args.versionLabel : undefined;
        const wantSnapshot = args.createVersion === true;

        // FOLD 1, R2c — a `versionLabel` without `createVersion` was accepted
        // and silently dropped, so an agent that asked for a LABELLED
        // checkpoint got no checkpoint at all and was told the write succeeded.
        // REFUSED rather than implying `createVersion: true`: implying it would
        // write a snapshot row nobody asked for and spend one of the fifty.
        if (label !== undefined && !wantSnapshot) {
          throw new Error(
            "`versionLabel` labels the snapshot that `createVersion: true` takes, and " +
              "`createVersion` was not set — so no snapshot would be taken and the label would be " +
              "dropped. Pass `createVersion: true` as well, or drop the label. Nothing was written.",
          );
        }
        const notes: string[] = [];

        // The snapshot is a SEPARATE call that must precede the write, because
        // card 162's PATCH takes no snapshot flags (and decodes with
        // DisallowUnknownFields, so sending one is a 400). If it is refused the
        // whole call is refused: the agent asked for the previous text to be
        // kept, and writing without it loses exactly what it wanted kept.
        const snapshot = async () => {
          if (!wantSnapshot) return;
          const { version } = await c.createPageSnapshot(id, label);
          snapshotId = version.id;
        };

        let page: Page;
        let versionId: string | undefined;

        if (hasEdits) {
          const edits = parseEdits(args.edits);
          const got = await c.getPage(id);
          let body = applyEditsOrRefuse(got.page.body, edits, "first");
          let base = got.page.revision;
          await snapshot();
          // D1(b)4–5 — THE ONE RETRY, written as a BOUNDED loop whose budget is
          // named once (PAGE_EDIT_ATTEMPTS: the first write plus one retry). The
          // retry proceeds ONLY if every `oldText` still matches exactly once in
          // the NEW body — applyEditsOrRefuse("retry") is what refuses
          // otherwise, and a refusal writes nothing. A second retry is
          // deliberately unavailable: an unbounded loop here is a write race
          // nobody outside can see, and the honest answer to a page that keeps
          // moving is to hand it back to the agent.
          for (let attempt = 1; ; attempt++) {
            try {
              const res = await c.patchPage(id, { baseRevision: base, body, ...meta });
              page = res.page;
              versionId = res.versionId;
              break;
            } catch (e) {
              const isConflict =
                e instanceof DiagramzuApiError &&
                e.status === 409 &&
                e.token === "revision_conflict";
              if (!isConflict || attempt >= PAGE_EDIT_ATTEMPTS) throw e;
              // The 409's own `current` is the exact state that refused the
              // write — body and revision out of ONE snapshot, with no window
              // between reading the text and naming the revision it belongs to.
              // Card 162 sends it precisely so a client needs no second round
              // trip; a re-GET is the fallback for an API that did not.
              const fresh = conflictCurrent(e) ?? (await c.getPage(id)).page;
              body = applyEditsOrRefuse(fresh.body, edits, "retry");
              base = fresh.revision;
              notes.push(
                "Another writer changed the page first, so YOUR edits were re-applied on top of " +
                  "THEIR text. Their change is intact and yours is in; nothing was overwritten.",
              );
            }
          }
          notes.unshift(`Applied ${edits.length} edit${edits.length === 1 ? "" : "s"}.`);
        } else if (hasBody) {
          await snapshot();
          const res = await c.patchPage(id, {
            baseRevision: baseRevision as number,
            body: args.body as string,
            ...meta,
          });
          page = res.page;
          versionId = res.versionId;
        } else {
          await snapshot();
          const res = await c.patchPage(id, { ...meta });
          page = res.page;
          versionId = res.versionId;
        }

        const lines = [
          `Updated page: ${page.id}`,
          `Title: ${page.title}`,
          `Revision: ${page.revision}`,
          ...notes,
        ];
        // Either snapshot is worth naming: the one the agent asked for, and the
        // one go-api took by itself when the writer changed.
        if (snapshotId) lines.push(`Snapshot: ${snapshotId}`);
        if (versionId && versionId !== snapshotId) lines.push(`Snapshot: ${versionId}`);
        lines.push(...pageOpenLines(c, page.id));
        return lines.join("\n");
      },
      // FOLD 1, S1 — every refusal after the snapshot names it. `snapshotId` is
      // read when the failure is explained, so it is set only if the POST
      // really landed.
      () =>
        snapshotId
          ? `NOT quite nothing, though: the named snapshot \`${snapshotId}\` you asked for WAS ` +
            `taken before this attempt and is still there. The page's TEXT is unchanged; what was ` +
            `spent is one of its fifty named versions. Retry WITHOUT createVersion — you already ` +
            `have the checkpoint — or delete that snapshot in DiagramZu if you do not want it.`
          : null,
      );
    },
  );
}
