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
  code: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
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

  list(): Promise<{ diagrams: DiagramSummary[] }> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/diagrams`);
  }

  get(id: string): Promise<{ diagram: Diagram }> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/diagrams/${id}`);
  }

  create(body: { title?: string; code?: string; style?: string }): Promise<{ diagram: Diagram }> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/diagrams`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  update(id: string, body: { title?: string; code?: string; style?: string }): Promise<{ diagram: Diagram }> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/diagrams/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  remove(id: string): Promise<void> {
    return this.req(`/api/spaces/${this.cfg.spaceId}/diagrams/${id}`, { method: "DELETE" });
  }

  diagramUrl(id: string): string {
    return `${this.cfg.baseUrl}/app/d/${id}`;
  }
}
