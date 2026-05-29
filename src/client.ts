export interface DiagramzuConfig {
  baseUrl: string;
  token: string;
  spaceId: string;
}

export interface DiagramSummary {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string;
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

export class DiagramzuClient {
  constructor(private readonly cfg: DiagramzuConfig) {}

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
    sort?: "created" | "updated" | "title";
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

  update(id: string, body: { title?: string; code?: string; style?: string; styleOptions?: Record<string, unknown>; description?: string | null; createVersion?: boolean; versionLabel?: string; folderId?: string }): Promise<{ diagram: Diagram; versionId?: string; warnings?: string[] }> {
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

  // Look-up only. Returns the public share URL when an active link exists,
  // null otherwise. Mirrors apps/web/server/utils/mcp/tools.ts. Fail-open.
  async getActiveShareUrl(diagramId: string): Promise<string | null> {
    try {
      const { link } = await this.req<{ link: { slug: string } | null }>(
        `/api/spaces/${this.cfg.spaceId}/diagrams/${diagramId}/shares`,
      );
      return link ? `${this.cfg.baseUrl}/s/${link.slug}` : null;
    } catch {
      return null;
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

  diagramUrl(id: string): string {
    return `${this.cfg.baseUrl}/app/d/${id}`;
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

  /** Decks present at /app/present/:id (the full-bleed presentation surface). */
  deckUrl(id: string): string {
    return `${this.cfg.baseUrl}/app/present/${id}`;
  }
}
