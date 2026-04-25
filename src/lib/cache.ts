export type CacheStatus = "hit" | "miss" | "bypass" | "not_applicable";

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now()
  ) {}

  get(key: string): { status: CacheStatus; value?: T } {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) {
        this.entries.delete(key);
      }
      return { status: "miss" };
    }

    return { status: "hit", value: entry.value };
  }

  set(key: string, value: T): void {
    if (this.ttlMs <= 0) {
      return;
    }

    this.entries.set(key, {
      value,
      expiresAt: this.now() + this.ttlMs
    });
  }

  async getOrSet(key: string, load: () => Promise<T>): Promise<{ status: CacheStatus; value: T }> {
    const cached = this.get(key);
    if (cached.status === "hit") {
      return { status: "hit", value: cached.value as T };
    }

    const value = await load();
    this.set(key, value);
    return { status: this.ttlMs > 0 ? "miss" : "bypass", value };
  }
}

export function ttlSecondsFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultSeconds: number,
  minSeconds: number,
  maxSeconds: number
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return defaultSeconds;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return defaultSeconds;
  }

  return Math.min(maxSeconds, Math.max(minSeconds, Math.floor(parsed)));
}

export function ttlMsFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultSeconds: number,
  minSeconds: number,
  maxSeconds: number
): number {
  return ttlSecondsFromEnv(env, name, defaultSeconds, minSeconds, maxSeconds) * 1000;
}
