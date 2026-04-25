import { describe, expect, it } from "vitest";
import { TtlCache, ttlSecondsFromEnv } from "../src/lib/cache.js";
import { fetchJson } from "../src/lib/http.js";

describe("fetchJson", () => {
  it("uses GET JSON requests without auth headers", async () => {
    const seenHeaders: Headers[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenHeaders.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    };

    const result = await fetchJson<{ ok: boolean }>(
      new URL("https://api.elections.kalshi.com/trade-api/v2/markets?limit=1"),
      { fetchImpl, timeoutMs: 1000 }
    );

    expect(result).toEqual({ ok: true });
    expect(seenHeaders[0].get("accept")).toBe("application/json");
    expect(seenHeaders[0].has("authorization")).toBe(false);
    expect(seenHeaders[0].has("kalshi-access-key")).toBe(false);
    expect(seenHeaders[0].has("kalshi-access-signature")).toBe(false);
    expect(seenHeaders[0].has("kalshi-access-timestamp")).toBe(false);
  });

  it("does not follow HTTP redirects", async () => {
    const seenRedirectModes: Array<RequestRedirect | undefined> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      seenRedirectModes.push(init?.redirect);
      return new Response(null, {
        status: 302,
        statusText: "Found",
        headers: {
          location: "https://example.com/markets"
        }
      });
    };

    await expect(
      fetchJson(new URL("https://api.elections.kalshi.com/trade-api/v2/markets?limit=1"), {
        fetchImpl,
        timeoutMs: 1000
      })
    ).rejects.toThrow("302 Found");
    expect(seenRedirectModes).toEqual(["manual"]);
  });

  it("blocks non-allowlisted origins", async () => {
    await expect(fetchJson(new URL("https://example.com/markets"), { timeoutMs: 1000 })).rejects.toThrow(
      "Blocked non-allowlisted URL origin"
    );
  });
});

describe("TtlCache", () => {
  it("returns misses, hits, and expires entries", async () => {
    let now = 1000;
    let loads = 0;
    const cache = new TtlCache<number>(50, () => now);

    const first = await cache.getOrSet("a", async () => {
      loads += 1;
      return 1;
    });
    const second = await cache.getOrSet("a", async () => {
      loads += 1;
      return 2;
    });

    now = 1051;
    const third = await cache.getOrSet("a", async () => {
      loads += 1;
      return 3;
    });

    expect(first).toEqual({ status: "miss", value: 1 });
    expect(second).toEqual({ status: "hit", value: 1 });
    expect(third).toEqual({ status: "miss", value: 3 });
    expect(loads).toBe(2);
  });

  it("sweeps expired entries when setting a new value", async () => {
    let now = 1000;
    const cache = new TtlCache<number>(50, () => now, 10);

    await cache.getOrSet("a", async () => 1);
    await cache.getOrSet("b", async () => 2);
    now = 1051;
    await cache.getOrSet("c", async () => 3);

    expect(cache.size()).toBe(1);
    expect(cache.get("a").status).toBe("miss");
    expect(cache.get("b").status).toBe("miss");
    expect(cache.get("c")).toEqual({ status: "hit", value: 3 });
  });

  it("evicts the oldest entries at the configured size cap", async () => {
    const cache = new TtlCache<number>(1000, () => 1000, 2);

    await cache.getOrSet("a", async () => 1);
    await cache.getOrSet("b", async () => 2);
    await cache.getOrSet("c", async () => 3);

    expect(cache.size()).toBe(2);
    expect(cache.get("a").status).toBe("miss");
    expect(cache.get("b")).toEqual({ status: "hit", value: 2 });
    expect(cache.get("c")).toEqual({ status: "hit", value: 3 });
  });

  it("parses TTL env values with safe defaults and clamps", () => {
    expect(ttlSecondsFromEnv({}, "TTL", 20, 0, 30)).toBe(20);
    expect(ttlSecondsFromEnv({ TTL: "999" }, "TTL", 20, 0, 30)).toBe(30);
    expect(ttlSecondsFromEnv({ TTL: "-1" }, "TTL", 20, 0, 30)).toBe(0);
    expect(ttlSecondsFromEnv({ TTL: "bad" }, "TTL", 20, 0, 30)).toBe(20);
  });
});
