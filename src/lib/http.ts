import { assertAllowlistedUrl } from "./validation.js";

export const ESPN_SITE_ORIGIN = "https://site.api.espn.com";
export const KALSHI_ORIGIN = "https://api.elections.kalshi.com";
export const ALLOWED_ORIGINS = [ESPN_SITE_ORIGIN, KALSHI_ORIGIN] as const;

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly url: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface FetchJsonOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function fetchJson<T>(url: URL, options: FetchJsonOptions = {}): Promise<T> {
  assertAllowlistedUrl(url, ALLOWED_ORIGINS);

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("No fetch implementation is available in this Node runtime");
  }

  const timeoutMs = options.timeoutMs ?? timeoutMsFromEnv(process.env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new HttpError(
        `GET ${url.toString()} failed with ${response.status} ${response.statusText}`,
        response.status,
        url.toString()
      );
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new HttpError(
        `GET ${url.toString()} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        response.status,
        url.toString()
      );
    }
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(`GET ${url.toString()} timed out after ${timeoutMs}ms`, undefined, url.toString());
    }

    throw new HttpError(
      `GET ${url.toString()} failed: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      url.toString()
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function timeoutMsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.SPORTS_KALSHI_HTTP_TIMEOUT_MS;
  if (!raw) {
    return 10000;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return 10000;
  }

  return Math.min(30000, Math.max(1000, Math.floor(parsed)));
}

export function buildUrl(origin: string, pathSegments: readonly string[], query?: Record<string, string | number | undefined>): URL {
  const url = new URL(origin);
  url.pathname = pathSegments.map((segment) => encodeURIComponent(segment)).join("/");

  if (!url.pathname.startsWith("/")) {
    url.pathname = `/${url.pathname}`;
  }

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  assertAllowlistedUrl(url, ALLOWED_ORIGINS);
  return url;
}
