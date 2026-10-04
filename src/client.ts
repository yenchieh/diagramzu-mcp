export interface DiagramzuConfig {
  /** Base URL for the REST API (e.g. the Go API host / in-cluster service). */
  baseUrl: string;
  token: string;
  /**
   * The Space every call in THIS client acts in. For the per-request client
   * built from `whoami` it is the token's DEFAULT Space; `inSpace()` returns a
   * sibling pointed at another one (card 160).
   */
  spaceId: string;
  /**
   * Display name of `spaceId`, so a tool result can say which Space it acted
   * in without a second API call. `whoami` returns it for the default Space,
   * and `listSpaces()` for every other.
   *
   * ABSENT IS MEANINGFUL, and it is not merely "unknown": whoami omits the
   * name exactly when the token's default Space is no longer REACHABLE (the
   * creator was removed from it, or it was deleted) while other Spaces still
   * are. Callers print the id, or — for the omitted-`space` case — the
   * "pass space explicitly" message.
   */
  spaceName?: string;
  /**
   * The token's scope as go-api reports it. "account" means a `space`
   * argument may name any Space the creator is a live member of; "space"
   * means only the default one exists for this token.
   */
  scope?: "space" | "account";
  /**
   * False when the token's default Space is no longer reachable. The token is
   * still usable — in its OTHER Spaces — so the tools must not fail the whole
   * request; they refuse only the calls that omit `space`.
   */
  defaultReachable?: boolean;
  /**
   * Base URL used ONLY for the user-facing links in tool output
   * (diagramUrl / deckUrl / share URL / upgrade link), e.g.
   * "https://diagramzu.ai". Defaults to `baseUrl` when omitted.
   *
   * The remote MCP service calls the REST API at an internal `baseUrl` but must
   * still show humans public diagramzu.ai URLs — set `siteBaseUrl` for that. For
   * the stdio single-host use-case the two are the same, so it can be omitted.
   */
  siteBaseUrl?: string;
}

/**
 * Who performed a write (card 84). `kind` is derived server-side from the
 * presence of an acting API-token name: a write made through a bearer token
 * (MCP / OAuth) is `"agent"`, a write made in the browser editor is `"user"`.
 * `tokenName` is the token's name as it was at write time — a snapshot, not a
 * reference, because OAuth access-token rows are rotated away within the hour.
 *
 * Older rows predate the column and always report `kind: "user"` with a null
 * `tokenName`: their acting token was never recorded and cannot be recovered.
 */
export interface Actor {
  kind: "agent" | "user";
  userId: string;
  tokenName: string | null;
}

export interface DiagramSummary {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  createdActor?: Actor;
  updatedActor?: Actor;
}

export interface Diagram {
  id: string;
  spaceId: string;
  title: string;
  description?: string | null;
  code: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  createdActor?: Actor;
  updatedActor?: Actor;
}

export interface FolderRow {
  id: string;
  spaceId: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeckSummary {
  id: string;
  title: string;
  updatedAt: string;
  slideCount: number;
}

export interface DeckSlideRef {
  diagramId: string;
  title: string;
  position: number;
}

export interface DeckDetail {
  deck: { id: string; title: string; description: string | null };
  slides: DeckSlideRef[];
}

export interface CreateDeckInput {
  title?: string;
  description?: string | null;
  slides?: string[];
}

export interface UpdateDeckInput {
  title?: string;
  description?: string | null;
  slides?: string[];
}

/**
 * The result of an active-public-link lookup. `unknown` means the lookup did
 * not complete — NOT that there is no link. Never render it as a negative.
 */
export type ActiveShareLookup =
  | { state: "link"; url: string }
  | { state: "none" }
  | { state: "unknown" };

/** One Space a token may act in, as GET /api/token/spaces reports it. */
export interface TokenSpace {
  id: string;
  slug: string;
  name: string;
  role: string;
  isDefault: boolean;
}

export class DiagramzuClient {
  constructor(private readonly cfg: DiagramzuConfig) {}

  /** REST API base URL. Used for the underlying `fetch` calls. */
  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  /** The Space id every call on this client acts in. */
  get spaceId(): string {
    return this.cfg.spaceId;
  }

  /**
   * How to NAME this client's Space in a tool result: its display name when we
   * have one, else the id. Never empty, because "in space " with nothing after
   * it is worse than an id.
   */
  get spaceLabel(): string {
    return this.cfg.spaceName ?? this.cfg.spaceId;
  }

  /** The token's scope; "space" when go-api did not say (an older API). */
  get scope(): "space" | "account" {
    return this.cfg.scope ?? "space";
  }

  /**
   * Whether the DEFAULT Space is usable. Only false for an account-scoped
   * token whose default Space it has lost — in which case a call that omits
   * `space` cannot be served and must say so.
   */
  get defaultReachable(): boolean {
    return this.cfg.defaultReachable ?? true;
  }

  /**
   * A sibling client pointed at a different Space, same token and same hosts.
   *
   * This is how the per-call `space` argument works, and it is ONE place
   * rather than a `space` parameter threaded through 20 request methods: every
   * path is built from `this.cfg.spaceId`, so re-pointing the config re-points
   * all of them at once and a method added later is covered by construction.
   */
  inSpace(space: { id: string; name?: string }): DiagramzuClient {
    return new DiagramzuClient({
      ...this.cfg,
      spaceId: space.id,
      ...(space.name === undefined ? {} : { spaceName: space.name }),
      // The sibling's Space was resolved from a live listing, so it IS
      // reachable — whatever the DEFAULT Space's state is.
      defaultReachable: true,
    });
  }

  /**
   * Every Space this token may act in (card 160).
   *
   * NEVER CACHED ACROSS REQUESTS, and that is a correctness property rather
   * than a performance choice: membership is live, so a cached list keeps
   * offering a Space the holder was removed from. go-api would refuse the
   * call with a 401, but the agent would have been told the Space is there —
   * and a tool that lists a Space it cannot use is worse than one that does
   * not list it. mcp-svc builds a fresh client per request, so the natural
   * lifetime of this value is one MCP request; nothing here extends it.
   */
  async listSpaces(): Promise<TokenSpace[]> {
    const { spaces } = await this.req<{ spaces: TokenSpace[] }>("/api/token/spaces");
    return spaces;
  }

  /**
   * Base URL for user-facing links shown in tool responses (upgrade link,
   * diagram/deck/share URLs). Falls back to `baseUrl` when `siteBaseUrl` is
   * not configured (the stdio single-host case).
   */
  get siteBaseUrl(): string {
    return this.cfg.siteBaseUrl ?? this.cfg.baseUrl;
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.token}`,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`diagramzu API ${res.status}: ${text || res.statusText}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  list(params?: {
    q?: string;
    owner?: string;
    sort?: "created" | "updated" | "title" | "relevance";
    folderId?: string;
  }): Promise<{ diagrams: DiagramSummary[] }> {
    // PARITY: mirror apps/web/server/utils/mcp/tools.ts InProcessClient.list —
    // folderId narrows to one folder; otherwise force all=true so agents see
    // every folder. (Server ignores folderId when all=true.)
    const search = new URLSearchParams();
    if (params?.folderId) search.set("folderId", params.folderId);
    else search.set("all", "true");
    if (params?.q) search.set("q", params.q);
    if (params?.owner) search.set("owner", params.owner);
    if (params?.sort) search.set("sort", params.sort);
    return this.req(
      `/api/spaces/${this.cfg.spaceId}/diagrams?${search.toString()}`,
    );
  }

  get(id: string): Promise<{ diagram: Diagram }> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/diagrams/${id}`);
  }

  create(body: { title?: string; code?: string; style?: string; styleOptions?: Record<string, unknown>; description?: string | null; folderId?: string }): Promise<{ diagram: Diagram; warnings?: string[] }> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/diagrams`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  update(
    id: string,
    body: Record<string, unknown>,
  ): Promise<{
    diagram?: { id: string };
    versionId?: string;
    warnings?: string[];
    status?: string;
    proposalId?: string;
  }> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/diagrams/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  analyze(id: string, opts?: { postAsComments?: boolean }): Promise<{ text: string }> {
    const qs = opts?.postAsComments ? "?postAsComments=true" : "";
    return this.req(`/api/spaces/${this.cfg.spaceId}/diagrams/${id}/analysis${qs}`);
  }

  listComments(
    diagramId: string,
    params: { nodeId?: string; includeResolved?: boolean; limit?: number; offset?: number },
  ): Promise<{
    items: Array<{
      id: string;
      parentId: string | null;
      nodeId: string | null;
      body: string;
      resolvedAt: string | null;
      authorId: string;
      authorName: string | null;
      createdAt: string;
    }>;
    total: number;
  }> {
    const search = new URLSearchParams();
    if (params.nodeId) search.set("nodeId", params.nodeId);
    if (params.includeResolved !== undefined) search.set("includeResolved", String(params.includeResolved));
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    if (params.offset !== undefined) search.set("offset", String(params.offset));
    const qs = search.toString();
    return this.req(
      `/api/spaces/${this.cfg.spaceId}/diagrams/${diagramId}/comments${qs ? `?${qs}` : ""}`,
    );
  }

  addComment(
    diagramId: string,
    body: { body: string; nodeId?: string; parentId?: string },
  ): Promise<{ comment: { id: string } }> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/diagrams/${diagramId}/comments`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * Look-up only: does this diagram have an active public link?
   *
   * THREE states, not two (card 136 fold 2, M1). This used to collapse
   * "the API said there is no link" and "the call failed" into a single
   * `null`, and `get_diagram` printed that null as the confident sentence
   * "No public link yet". The fold reviewer drove the built handler against a
   * stub whose `/shares` answered 500 and then 429 **while a live link
   * existed**, and the tool told the agent the diagram was private. An agent
   * acting on that goes and mints a second link, or tells a human their
   * diagram is not shared when it is.
   *
   * Fail-open is still the right POLICY — a flaky shares lookup must not fail
   * a `get_diagram` — but the failure has to be legible to the caller instead
   * of being laundered into a fact. Hence `unknown`.
   */
  async lookupActiveShare(diagramId: string): Promise<ActiveShareLookup> {
    try {
      const { link } = await this.req<{ link: { slug: string } | null }>(
        `/api/spaces/${this.cfg.spaceId}/diagrams/${diagramId}/shares`,
      );
      return link
        ? { state: "link", url: `${this.siteBaseUrl}/s/${link.slug}` }
        : { state: "none" };
    } catch {
      return { state: "unknown" };
    }
  }

  remove(id: string): Promise<void> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/diagrams/${id}`, { method: "DELETE" });
  }

  listVersions(diagramId: string, params: { limit?: number; offset?: number }): Promise<{
    items: Array<{
      id: string;
      label: string | null;
      title: string;
      createdAt: string;
      createdBy: string;
      // Optional: a go-api older than card 84 omits it. Formatting degrades to
      // the pre-84 row rather than printing "undefined".
      actor?: Actor;
    }>;
    total: number;
  }> {
    const search = new URLSearchParams();
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    if (params.offset !== undefined) search.set("offset", String(params.offset));
    const q = search.toString();
    return this.req(
      `/api/spaces/${this.cfg.spaceId}/diagrams/${diagramId}/versions${q ? `?${q}` : ""}`,
    );
  }

  getVersion(diagramId: string, versionId: string): Promise<{
    version: {
      id: string;
      label: string | null;
      title: string;
      code: string;
      style: string | null;
      styleOptions: string | null;
      description: string | null;
      createdAt: string;
      createdBy: string;
    };
  }> {
    return this.req(
      `/api/spaces/${this.cfg.spaceId}/diagrams/${diagramId}/versions/${versionId}`,
    );
  }

  listFolders(): Promise<{ folders: FolderRow[] }> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/folders`);
  }

  /**
   * The diagram's URL in the app, carrying the Space it lives in.
   *
   * `?space=` is load-bearing for an account-scoped token (card 160): the link
   * is pasted to a human whose ACTIVE Space in the browser is very likely a
   * different one, and without the parameter that page renders "not found".
   * The web switches Space when the visitor is a member and strips the
   * parameter afterwards.
   */
  diagramUrl(id: string): string {
    return `${this.siteBaseUrl}/app/d/${id}?space=${encodeURIComponent(this.cfg.spaceId)}`;
  }

  listDecks(): Promise<{ decks: DeckSummary[] }> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/decks`);
  }

  getDeck(id: string): Promise<DeckDetail> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/decks/${id}`);
  }

  createDeck(body: CreateDeckInput): Promise<{ deck: { id: string; title: string } }> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/decks`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  updateDeck(
    id: string,
    body: UpdateDeckInput,
  ): Promise<{ deck: { id: string; title: string } }> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/decks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  /**
   * Decks present at /app/present/:id (the full-bleed presentation surface).
   *
   * MEMBERS ONLY. This path is behind the /app auth guard, so a stakeholder who
   * receives it is bounced to sign-in — which is why every tool description that
   * returns it says so, and why none of them calls it a URL "to share".
   *
   * The public link is /s/p/:slug (card 130), minted from the deck's Share
   * button in the app. It is deliberately NOT mintable from here: publishing a
   * Space's content is a human decision, not an agent's. If that ever changes it
   * needs its own tool and its own consent story, not a wording change.
   */
  deckUrl(id: string): string {
    return `${this.siteBaseUrl}/app/present/${id}?space=${encodeURIComponent(this.cfg.spaceId)}`;
  }
}
