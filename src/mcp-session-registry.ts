interface ClosableResource {
  close(): Promise<void>;
}

interface RegistryEntry<T extends ClosableResource> {
  resource: T;
  scope: string;
  lastUsedAt: number;
}

export class McpSessionRegistry<T extends ClosableResource> {
  readonly #entries = new Map<string, RegistryEntry<T>>();

  constructor(
    private readonly maxSessions: number,
    private readonly idleMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.#entries.size;
  }

  get(id: string, scope: string): T | undefined {
    this.pruneExpired();
    const entry = this.#entries.get(id);
    if (!entry || entry.scope !== scope) return undefined;
    entry.lastUsedAt = this.now();
    this.#entries.delete(id);
    this.#entries.set(id, entry);
    return entry.resource;
  }

  register(id: string, scope: string, resource: T): void {
    this.pruneExpired();
    const replaced = this.#entries.get(id);
    if (replaced) this.evict(id, replaced);
    while (this.#entries.size >= this.maxSessions) {
      const oldestId = this.#entries.keys().next().value;
      if (typeof oldestId !== "string") break;
      const oldest = this.#entries.get(oldestId);
      if (oldest) this.evict(oldestId, oldest);
    }
    this.#entries.set(id, { resource, scope, lastUsedAt: this.now() });
  }

  delete(id: string): void {
    this.#entries.delete(id);
  }

  async closeAll(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.allSettled(entries.map(({ resource }) => resource.close()));
  }

  async closeScopePrefix(prefix: string): Promise<void> {
    const resources: T[] = [];
    for (const [id, entry] of this.#entries) {
      if (!entry.scope.startsWith(prefix)) continue;
      this.#entries.delete(id);
      resources.push(entry.resource);
    }
    await Promise.allSettled(resources.map((resource) => resource.close()));
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [id, entry] of this.#entries) {
      if (entry.lastUsedAt <= cutoff) this.evict(id, entry);
    }
  }

  private evict(id: string, entry: RegistryEntry<T>): void {
    this.#entries.delete(id);
    void entry.resource.close().catch(() => undefined);
  }
}
