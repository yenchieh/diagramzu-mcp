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
    // force all=true so agents see every folder by default. Pass folderId
    // to narrow to one folder.
    const search = new URLSearchParams({ all: "true" });
    if (params?.q) search.set("q", params.q);
    if (params?.owner) search.set("owner", params.owner);
    if (params?.sort) search.set("sort", params.sort);
    if (params?.folderId) search.set("folderId", params.folderId);
    return this.req(
      `/api/spaces/${this.cfg.spaceId}/diagrams?${search.toString()}`,
    );
  }

  get(id: string): Promise<{ diagram: Diagram }> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/diagrams/${id}`);
  }

  create(body: { title?: string; code?: string; style?: string; styleOptions?: Record<string, unknown>; description?: string | null; folderId?: string }): Promise<{ diagram: Diagram }> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/diagrams`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  update(id: string, body: { title?: string; code?: string; style?: string; styleOptions?: Record<string, unknown>; description?: string | null; createVersion?: boolean; versionLabel?: string; folderId?: string }): Promise<{ diagram: Diagram; versionId?: string }> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/diagrams/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  analyze(id: string): Promise<{ text: string }> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/diagrams/${id}/analysis`);
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
}
