import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { EspnClient } from "../clients/espn.js";
import { KalshiClient } from "../clients/kalshi.js";
import type { HistoricalProjectionClient } from "../nba/historical-client.js";
import { searchGamesByTeam } from "./games-search.js";
import { getNbaProjections } from "./nba-projections.js";

const DEFAULT_PORT = 8080;

export function createHttpHandler(
  input: {
    publicDir?: string;
    espnClient?: EspnClient;
    kalshiClient?: KalshiClient;
    historicalClient?: HistoricalProjectionClient;
  } = {}
) {
  const publicDir = path.resolve(input.publicDir ?? process.env.SPORTS_PROJECTOR_PUBLIC_DIR ?? "public");
  const espnClient = input.espnClient ?? new EspnClient();
  const kalshiClient = input.kalshiClient ?? new KalshiClient();
  const historicalClient = input.historicalClient;

  return async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      writeJson(response, 400, { error: "Invalid request URL." });
      return;
    }

    if (url.pathname === "/api/nba/projections") {
      await handleNbaProjections(request, response, url, {
        espnClient,
        kalshiClient,
        historicalClient
      });
      return;
    }

    if (url.pathname === "/api/games/search") {
      await handleGamesSearch(request, response, url, espnClient);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      writeJson(response, 404, { error: "API route not found." });
      return;
    }

    await serveStatic(request, response, publicDir, url.pathname);
  };
}

async function handleGamesSearch(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  espnClient: EspnClient
): Promise<void> {
  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    writeJson(response, 405, { error: "Method not allowed." });
    return;
  }

  const result = await searchGamesByTeam(url.searchParams, espnClient);
  writeJson(response, result.status, result.body);
}

async function handleNbaProjections(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  clients: {
    espnClient: EspnClient;
    kalshiClient: KalshiClient;
    historicalClient?: HistoricalProjectionClient;
  }
): Promise<void> {
  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    writeJson(response, 405, { error: "Method not allowed." });
    return;
  }

  const result = await getNbaProjections(url.searchParams, clients);
  writeJson(response, result.status, result.body);
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  publicDir: string,
  pathname: string
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    writeText(response, 405, "Method not allowed.");
    return;
  }

  const filePath = resolveStaticPath(publicDir, pathname);
  if (filePath === null) {
    writeText(response, 400, "Invalid path.");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    response.statusCode = 200;
    response.setHeader("content-type", contentType(filePath));
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    response.end(file);
  } catch (error) {
    const status = isNotFound(error) ? 404 : 500;
    writeText(response, status, status === 404 ? "Not found." : "Unable to read static asset.");
  }
}

function resolveStaticPath(publicDir: string, pathname: string): string | null {
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const normalizedPathname = decodedPathname === "/" ? "/index.html" : decodedPathname;
  const relativePath = path.normalize(normalizedPathname).replace(/^[/\\]+/, "");
  const resolvedPublicDir = path.resolve(publicDir);
  const resolvedFilePath = path.resolve(resolvedPublicDir, relativePath);

  if (resolvedFilePath !== resolvedPublicDir && !resolvedFilePath.startsWith(`${resolvedPublicDir}${path.sep}`)) {
    return null;
  }

  return resolvedFilePath;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function writeText(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const server = createServer(createHttpHandler());

  server.listen(port, () => {
    console.error(`sports-projector web app listening on http://localhost:${port}`);
  });
}
