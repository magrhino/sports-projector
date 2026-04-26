import type { GameSearchResponse, League, LiveGamesResponse, ProjectionPayload, TrackerStatusPayload } from "./types";

export async function searchGames(team: string, league: League, signal?: AbortSignal): Promise<GameSearchResponse> {
  const params = new URLSearchParams({ team, league });
  return fetchJson<GameSearchResponse>(`/api/games/search?${params.toString()}`, { signal });
}

export async function fetchLiveGames(league: League, signal?: AbortSignal): Promise<LiveGamesResponse> {
  const params = new URLSearchParams({ league });
  return fetchJson<LiveGamesResponse>(`/api/games/live?${params.toString()}`, { signal });
}

export async function fetchProjection(
  eventId: string,
  scope: "all" | "live",
  signal?: AbortSignal
): Promise<ProjectionPayload> {
  const params = new URLSearchParams({ event_id: eventId, scope });
  return fetchJson<ProjectionPayload>(`/api/nba/projections?${params.toString()}`, { signal });
}

export async function fetchTrackerStatus(signal?: AbortSignal): Promise<TrackerStatusPayload> {
  return fetchJson<TrackerStatusPayload>("/api/nba/live-tracking/status", { signal });
}

export async function trainLiveModel(signal?: AbortSignal): Promise<TrackerStatusPayload> {
  return fetchJson<TrackerStatusPayload>("/api/nba/live-model/train", {
    method: "POST",
    signal
  });
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...init.headers
    }
  });
  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    const error = new Error(payload.error || "Request failed.");
    Object.assign(error, { payload });
    throw error;
  }

  return payload;
}

export function errorMessage(error: unknown, fallback = "Request failed."): string {
  if (error instanceof Error) {
    return error.message || fallback;
  }
  return String(error || fallback);
}

export function errorPayload(error: unknown): unknown {
  return error instanceof Error && "payload" in error ? error.payload : undefined;
}
