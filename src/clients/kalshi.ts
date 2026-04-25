import type { CacheStatus } from "../lib/cache.js";
import { TtlCache, ttlMsFromEnv } from "../lib/cache.js";
import { KALSHI_ORIGIN, buildUrl, fetchJson, type FetchJsonOptions } from "../lib/http.js";

interface CachedFetch<T> {
  cacheStatus: CacheStatus;
  data: T;
  sourceUrl: string;
}

interface KalshiClientOptions extends FetchJsonOptions {
  env?: NodeJS.ProcessEnv;
}

export interface NormalizedKalshiMarket {
  ticker: string | null;
  title: string | null;
  subtitle: string | null;
  event_ticker: string | null;
  series_ticker: string | null;
  status: string | null;
  open_time: string | null;
  close_time: string | null;
  expiration_time: string | null;
  yes_bid_cents: number | null;
  yes_ask_cents: number | null;
  no_bid_cents: number | null;
  no_ask_cents: number | null;
  last_price_cents: number | null;
  volume: number | null;
  liquidity: number | null;
  implied_probabilities: {
    yes_bid: number | null;
    yes_ask: number | null;
    no_bid: number | null;
    no_ask: number | null;
    last_price: number | null;
  };
}

export interface NormalizedOrderbookLevel {
  price_cents: number;
  price_dollars: number;
  implied_probability: number;
  quantity: number | null;
}

export function buildKalshiMarketsUrl(input: {
  limit?: number;
  cursor?: string;
  status?: string;
  seriesTicker?: string;
  eventTicker?: string;
}): URL {
  return buildUrl(KALSHI_ORIGIN, ["trade-api", "v2", "markets"], {
    limit: input.limit,
    cursor: input.cursor,
    status: input.status && input.status !== "all" ? input.status : undefined,
    series_ticker: input.seriesTicker,
    event_ticker: input.eventTicker
  });
}

export function buildKalshiMarketUrl(ticker: string): URL {
  return buildUrl(KALSHI_ORIGIN, ["trade-api", "v2", "markets", ticker]);
}

export function buildKalshiOrderbookUrl(ticker: string, depth?: number): URL {
  return buildUrl(KALSHI_ORIGIN, ["trade-api", "v2", "markets", ticker, "orderbook"], { depth });
}

export function buildKalshiTradesUrl(input: {
  limit?: number;
  cursor?: string;
  ticker?: string;
  minTs?: number;
  maxTs?: number;
}): URL {
  return buildUrl(KALSHI_ORIGIN, ["trade-api", "v2", "markets", "trades"], {
    limit: input.limit,
    cursor: input.cursor,
    ticker: input.ticker,
    min_ts: input.minTs,
    max_ts: input.maxTs
  });
}

export class KalshiClient {
  private readonly cache: TtlCache<unknown>;
  private readonly fetchOptions: FetchJsonOptions;

  constructor(options: KalshiClientOptions = {}) {
    const env = options.env ?? process.env;
    this.cache = new TtlCache<unknown>(
      ttlMsFromEnv(env, "SPORTS_KALSHI_KALSHI_TTL_SECONDS", 10, 0, 15)
    );
    this.fetchOptions = {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs
    };
  }

  async searchMarkets(input: {
    query?: string;
    limit?: number;
    cursor?: string;
    status?: string;
    seriesTicker?: string;
    eventTicker?: string;
  }): Promise<CachedFetch<unknown>> {
    const url = buildKalshiMarketsUrl(input);
    return this.fetchCached(url);
  }

  async getMarket(input: { ticker: string }): Promise<CachedFetch<unknown>> {
    return this.fetchCached(buildKalshiMarketUrl(input.ticker));
  }

  async getOrderbook(input: { ticker: string; depth?: number }): Promise<CachedFetch<unknown>> {
    return this.fetchCached(buildKalshiOrderbookUrl(input.ticker, input.depth));
  }

  async getTrades(input: {
    limit?: number;
    cursor?: string;
    ticker?: string;
    minTs?: number;
    maxTs?: number;
  }): Promise<CachedFetch<unknown>> {
    return this.fetchCached(buildKalshiTradesUrl(input));
  }

  private async fetchCached<T>(url: URL): Promise<CachedFetch<T>> {
    const key = url.toString();
    const result = await this.cache.getOrSet(key, async () => fetchJson<T>(url, this.fetchOptions));
    return {
      cacheStatus: result.status,
      data: result.value as T,
      sourceUrl: key
    };
  }
}

export function normalizeMarkets(raw: unknown, query?: string): {
  count: number;
  cursor: string | null;
  markets: NormalizedKalshiMarket[];
} {
  const data = asRecord(raw);
  const markets = asArray(data.markets).map(normalizeMarket);
  const filteredMarkets = query ? markets.filter((market) => marketMatchesQuery(market, query)) : markets;

  return {
    count: filteredMarkets.length,
    cursor: asString(data.cursor),
    markets: filteredMarkets
  };
}

export function normalizeSingleMarket(raw: unknown): NormalizedKalshiMarket {
  const data = asRecord(raw);
  return normalizeMarket(data.market ?? data);
}

export function normalizeOrderbook(raw: unknown): {
  yes_bids: NormalizedOrderbookLevel[];
  no_bids: NormalizedOrderbookLevel[];
  best_yes_bid_cents: number | null;
  best_no_bid_cents: number | null;
  implied_yes_ask_cents: number | null;
  spread_cents: number | null;
  explanation: string;
} {
  const data = asRecord(raw);
  const orderbook = asRecord(data.orderbook_fp ?? data.orderbook);
  const yesRaw = asArray(orderbook.yes_dollars ?? orderbook.yes);
  const noRaw = asArray(orderbook.no_dollars ?? orderbook.no);
  const yesIsDollars = Boolean(orderbook.yes_dollars);
  const noIsDollars = Boolean(orderbook.no_dollars);
  const yesBids = normalizeOrderbookLevels(yesRaw, yesIsDollars);
  const noBids = normalizeOrderbookLevels(noRaw, noIsDollars);
  const bestYesBid = yesBids[0]?.price_cents ?? null;
  const bestNoBid = noBids[0]?.price_cents ?? null;
  const impliedYesAsk = bestNoBid === null ? null : roundCents(100 - bestNoBid);
  const spread = bestYesBid === null || impliedYesAsk === null ? null : roundCents(impliedYesAsk - bestYesBid);

  return {
    yes_bids: yesBids,
    no_bids: noBids,
    best_yes_bid_cents: bestYesBid,
    best_no_bid_cents: bestNoBid,
    implied_yes_ask_cents: impliedYesAsk,
    spread_cents: spread,
    explanation:
      "Kalshi orderbooks expose YES bids and NO bids, not conventional asks. A NO bid at X cents implies a YES ask at 100 - X cents."
  };
}

export function normalizeTrades(raw: unknown): {
  count: number;
  cursor: string | null;
  trades: Array<{
    trade_id: string | null;
    ticker: string | null;
    count: number | null;
    yes_price_cents: number | null;
    no_price_cents: number | null;
    taker_side: string | null;
    created_time: string | null;
  }>;
} {
  const data = asRecord(raw);
  const trades = asArray(data.trades).map((trade) => {
    const item = asRecord(trade);
    return {
      trade_id: asString(item.trade_id),
      ticker: asString(item.ticker),
      count: numberFromValue(item.count_fp ?? item.count),
      yes_price_cents: centsFromValue(item.yes_price_dollars ?? item.yes_price),
      no_price_cents: centsFromValue(item.no_price_dollars ?? item.no_price),
      taker_side: asString(item.taker_side),
      created_time: asString(item.created_time)
    };
  });

  return {
    count: trades.length,
    cursor: asString(data.cursor),
    trades
  };
}

export function centsFromValue(value: unknown): number | null {
  const numeric = numberFromValue(value);
  if (numeric === null) {
    return null;
  }

  if (numeric <= 1) {
    return roundCents(numeric * 100);
  }

  return roundCents(numeric);
}

export function probabilityFromCents(cents: number | null): number | null {
  return cents === null ? null : roundProbability(cents / 100);
}

function normalizeMarket(raw: unknown): NormalizedKalshiMarket {
  const market = asRecord(raw);
  const yesBid = centsFromValue(market.yes_bid_dollars ?? market.yes_bid);
  const yesAsk = centsFromValue(market.yes_ask_dollars ?? market.yes_ask);
  const noBid = centsFromValue(market.no_bid_dollars ?? market.no_bid);
  const noAsk = centsFromValue(market.no_ask_dollars ?? market.no_ask);
  const lastPrice = centsFromValue(market.last_price_dollars ?? market.last_price);

  return {
    ticker: asString(market.ticker),
    title: asString(market.title),
    subtitle: asString(market.subtitle),
    event_ticker: asString(market.event_ticker),
    series_ticker: asString(market.series_ticker),
    status: asString(market.status),
    open_time: asString(market.open_time),
    close_time: asString(market.close_time),
    expiration_time: asString(market.expiration_time),
    yes_bid_cents: yesBid,
    yes_ask_cents: yesAsk,
    no_bid_cents: noBid,
    no_ask_cents: noAsk,
    last_price_cents: lastPrice,
    volume: numberFromValue(market.volume_fp ?? market.volume),
    liquidity: numberFromValue(market.liquidity ?? market.liquidity_dollars),
    implied_probabilities: {
      yes_bid: probabilityFromCents(yesBid),
      yes_ask: probabilityFromCents(yesAsk),
      no_bid: probabilityFromCents(noBid),
      no_ask: probabilityFromCents(noAsk),
      last_price: probabilityFromCents(lastPrice)
    }
  };
}

function normalizeOrderbookLevels(rawLevels: unknown[], valuesAreDollars: boolean): NormalizedOrderbookLevel[] {
  return rawLevels
    .map((level) => {
      const tuple = asArray(level);
      const price = valuesAreDollars ? centsFromValue(Number(tuple[0])) : centsFromValue(tuple[0]);
      if (price === null) {
        return null;
      }

      return {
        price_cents: price,
        price_dollars: roundDollars(price / 100),
        implied_probability: roundProbability(price / 100),
        quantity: numberFromValue(tuple[1])
      };
    })
    .filter((level): level is NormalizedOrderbookLevel => level !== null)
    .sort((left, right) => right.price_cents - left.price_cents);
}

function marketMatchesQuery(market: NormalizedKalshiMarket, query: string): boolean {
  const normalizedQuery = query.toLowerCase();
  return [
    market.ticker,
    market.title,
    market.subtitle,
    market.event_ticker,
    market.series_ticker
  ].some((field) => field?.toLowerCase().includes(normalizedQuery));
}

function numberFromValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function roundCents(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function roundDollars(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function roundProbability(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
