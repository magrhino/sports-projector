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

  it("parses TTL env values with safe defaults and clamps", () => {
    expect(ttlSecondsFromEnv({}, "TTL", 20, 0, 30)).toBe(20);
    expect(ttlSecondsFromEnv({ TTL: "999" }, "TTL", 20, 0, 30)).toBe(30);
    expect(ttlSecondsFromEnv({ TTL: "-1" }, "TTL", 20, 0, 30)).toBe(0);
    expect(ttlSecondsFromEnv({ TTL: "bad" }, "TTL", 20, 0, 30)).toBe(20);
  });
});
