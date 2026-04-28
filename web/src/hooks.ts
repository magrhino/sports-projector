import { useCallback, useEffect, useRef, useState } from "react";
import {
  errorMessage,
  errorPayload,
  fetchHistoricalRefreshStatus,
  fetchLiveGames,
  fetchProjection,
  fetchProjectorSettings,
  fetchTrackerStatus,
  searchGames,
  trainLiveModel,
  updateProjectorSettings
} from "./api";
import {
  formatDateTime,
  formatScoreStatus,
  formatTrainingError,
  isLiveGame,
  sortGames
} from "./format";
import type {
  Game,
  GameSearchResponse,
  HistoricalRefreshStatusPayload,
  League,
  ProjectionPayload,
  ProjectorSettings,
  SettingsPayload,
  TrackerStatusPayload
} from "./types";

export function useLiveGames(league: League) {
  const [games, setGames] = useState<Game[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const id = ++requestId.current;
      setLoaded(false);
      setError("");
      setGames([]);

      try {
        const payload = await fetchLiveGames(league, signal);
        if (id !== requestId.current) {
          return;
        }
        setGames(sortGames(Array.isArray(payload.games) ? payload.games : []));
        setLoaded(true);
      } catch (error) {
        if (signal?.aborted || id !== requestId.current) {
          return;
        }
        setGames([]);
        setLoaded(true);
        setError(errorMessage(error, "Unable to load live games."));
      }
    },
    [league]
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return { games, loaded, error, reload: load };
}

export function useGameSearch() {
  const [result, setResult] = useState<GameSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const requestId = useRef(0);

  const clear = useCallback(() => {
    requestId.current += 1;
    setResult(null);
    setError("");
    setStatus("");
    setLoading(false);
  }, []);

  const fail = useCallback((message: string) => {
    requestId.current += 1;
    setResult(null);
    setError(message);
    setStatus("");
    setLoading(false);
  }, []);

  const runSearch = useCallback(async (team: string, league: League) => {
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    setStatus("Loading...");

    try {
      const payload = await searchGames(team, league);
      if (id !== requestId.current) {
        return;
      }
      const games = sortGames(Array.isArray(payload.games) ? payload.games : []);
      setResult({ ...payload, games });
      setStatus(games.length === 0 ? "No games found." : "");
    } catch (error) {
      if (id !== requestId.current) {
        return;
      }
      setResult(null);
      setError(errorMessage(error, "Search failed."));
      setStatus("");
    } finally {
      if (id === requestId.current) {
        setLoading(false);
      }
    }
  }, []);

  return { result, loading, error, status, runSearch, clear, fail };
}

export function useProjectionDetail(league: League) {
  const [selectedGame, setSelectedGame] = useState<Game | null>(null);
  const [payload, setPayload] = useState<ProjectionPayload | null>(null);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [error, setError] = useState("");
  const [inFlight, setInFlight] = useState(false);
  const requestId = useRef(0);

  const clear = useCallback(() => {
    requestId.current += 1;
    setSelectedGame(null);
    setPayload(null);
    setLoadingMessage("");
    setError("");
    setInFlight(false);
  }, []);

  const loadProjection = useCallback(
    async (game: Game, scope: "all" | "live") => {
      const id = ++requestId.current;
      setInFlight(true);
      setError("");
      setLoadingMessage(scope === "live" ? "Updating live projection..." : "Loading projections...");

      try {
        const nextPayload = await fetchProjection(game.id, scope);
        if (id !== requestId.current) {
          return;
        }
        setPayload((current) => (scope === "live" ? { ...(current ?? {}), ...nextPayload } : nextPayload));
        setSelectedGame(nextPayload.game || game);
        setLoadingMessage(nextPayload.fetched_at ? `Updated ${formatDateTime(nextPayload.fetched_at)}.` : "");
      } catch (error) {
        if (id !== requestId.current) {
          return;
        }
        setError(errorMessage(error, "Projection request failed."));
        setLoadingMessage("");
      } finally {
        if (id === requestId.current) {
          setInFlight(false);
        }
      }
    },
    []
  );

  const selectGame = useCallback(
    async (game: Game) => {
      requestId.current += 1;
      setSelectedGame(game);
      setPayload(null);
      setError("");
      setLoadingMessage("");
      setInFlight(false);

      if (league !== "nba") {
        setError("Projection detail is only available for NBA games.");
        setPayload({
          event_id: game.id,
          game,
          live_projection: { status: "error", error: "NBA-only projection route." },
          historical_projection: { status: "error", error: "NBA-only projection route." }
        });
        return;
      }

      await loadProjection(game, "all");
    },
    [league, loadProjection]
  );

  const refresh = useCallback(() => {
    if (!selectedGame) {
      return;
    }
    void loadProjection(selectedGame, isLiveGame(selectedGame) ? "live" : "all");
  }, [loadProjection, selectedGame]);

  useEffect(() => {
    if (!selectedGame || !isLiveGame(selectedGame) || league !== "nba") {
      return undefined;
    }

    const timer = window.setInterval(() => {
      if (!inFlight) {
        void loadProjection(selectedGame, "live");
      }
    }, 10000);

    return () => window.clearInterval(timer);
  }, [inFlight, league, loadProjection, selectedGame]);

  const detailGame = payload?.game || selectedGame;
  const title = detailGame?.short_name || detailGame?.name || (payload?.event_id ? `ESPN event ${payload.event_id}` : "Projection");
  const meta = [
    formatScoreStatus(detailGame),
    payload?.event_id ? `ESPN event ${payload.event_id}` : null,
    payload?.fetched_at ? `Updated ${formatDateTime(payload.fetched_at)}` : null,
    detailGame && isLiveGame(detailGame) ? "Auto-refreshes every 10 seconds" : null
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    selectedGame: detailGame,
    payload,
    title,
    meta,
    loadingMessage,
    error,
    inFlight,
    selectGame,
    refresh,
    clear
  };
}

export function useLiveTrackerStatus() {
  const [payload, setPayload] = useState<TrackerStatusPayload | null>(null);
  const [message, setMessage] = useState("Loading tracker status...");
  const [training, setTraining] = useState(false);
  const statusRequestId = useRef(0);
  const trainRequestId = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const id = ++statusRequestId.current;
    try {
      const nextPayload = await fetchTrackerStatus(signal);
      if (id !== statusRequestId.current) {
        return;
      }
      setPayload(nextPayload);
      setMessage(trackerStatusMessage(nextPayload));
    } catch (error) {
      if (signal?.aborted || id !== statusRequestId.current) {
        return;
      }
      setMessage(errorMessage(error, "Unable to load tracker status."));
    }
  }, []);

  const train = useCallback(async () => {
    const id = ++trainRequestId.current;
    setTraining(true);
    setMessage("Training live model...");
    try {
      await trainLiveModel();
      const nextPayload = await fetchTrackerStatus();
      if (id !== trainRequestId.current) {
        return;
      }
      setPayload(nextPayload);
      setMessage(trackerStatusMessage(nextPayload));
    } catch (error) {
      if (id !== trainRequestId.current) {
        return;
      }
      const payload = errorPayload(error) as TrackerStatusPayload | undefined;
      if (payload?.tracker) {
        const nextPayload = {
          running: false,
          polling: false,
          last_error: null,
          tracker: payload.tracker
        };
        setPayload(nextPayload);
      }
      setMessage(formatTrainingError(payload || error));
    } finally {
      if (id === trainRequestId.current) {
        setTraining(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => {
      void load();
    }, 15000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load]);

  const tracker = payload?.tracker || {};
  const trainingState = tracker.training || {};
  const disabled = training || !tracker.enabled || !trainingState.ready;
  const title = !tracker.enabled
    ? "Live tracking is disabled."
    : trainingState.ready
      ? "Train the live correction model."
      : `Need ${trainingState.min_snapshots || "more"} finalized trainable snapshots; found ${
          trainingState.snapshots || 0
        }.`;

  return { payload, message, training, train, trainDisabled: disabled, trainTitle: title };
}

export function useSettingsDashboard() {
  const [settingsPayload, setSettingsPayload] = useState<SettingsPayload | null>(null);
  const [trackerPayload, setTrackerPayload] = useState<TrackerStatusPayload | null>(null);
  const [historicalPayload, setHistoricalPayload] = useState<HistoricalRefreshStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [training, setTraining] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const requestId = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const id = ++requestId.current;
    setLoading(true);
    setError("");

    try {
      const [settings, tracker, historical] = await Promise.all([
        fetchProjectorSettings(signal),
        fetchTrackerStatus(signal),
        fetchHistoricalRefreshStatus(signal)
      ]);
      if (id !== requestId.current) {
        return;
      }
      setSettingsPayload(settings);
      setTrackerPayload(tracker);
      setHistoricalPayload(historical);
      setMessage("");
    } catch (error) {
      if (signal?.aborted || id !== requestId.current) {
        return;
      }
      setError(errorMessage(error, "Unable to load settings."));
    } finally {
      if (id === requestId.current) {
        setLoading(false);
      }
    }
  }, []);

  const refreshStatuses = useCallback(async () => {
    const [tracker, historical] = await Promise.all([fetchTrackerStatus(), fetchHistoricalRefreshStatus()]);
    setTrackerPayload(tracker);
    setHistoricalPayload(historical);
  }, []);

  const saveSettings = useCallback(
    async (patch: Partial<ProjectorSettings>) => {
      setSaving(true);
      setError("");
      setMessage("");
      try {
        const nextSettings = await updateProjectorSettings(patch);
        setSettingsPayload(nextSettings);
        await refreshStatuses();
        setMessage("Settings saved.");
      } catch (error) {
        setError(errorMessage(error, "Unable to save settings."));
      } finally {
        setSaving(false);
      }
    },
    [refreshStatuses]
  );

  const train = useCallback(async () => {
    setTraining(true);
    setError("");
    setMessage("Training live model...");
    try {
      await trainLiveModel();
      await refreshStatuses();
      setMessage("Live model trained.");
    } catch (error) {
      const payload = errorPayload(error);
      if (payload && typeof payload === "object" && "tracker" in payload) {
        setTrackerPayload(payload as TrackerStatusPayload);
      }
      setError(formatTrainingError(payload || error));
      setMessage("");
    } finally {
      setTraining(false);
    }
  }, [refreshStatuses]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => {
      void load();
    }, 15000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load]);

  return {
    settingsPayload,
    trackerPayload,
    historicalPayload,
    loading,
    saving,
    training,
    error,
    message,
    load,
    saveSettings,
    train
  };
}

function trackerStatusMessage(payload: TrackerStatusPayload): string {
  const tracker = payload.tracker || {};
  const games = tracker.games || {};
  const latest = tracker.latest_snapshot;
  const model = tracker.model;
  const training = tracker.training || {};
  const trainingSnapshots = training.snapshots || 0;

  return [
    tracker.enabled ? "enabled" : "disabled",
    payload.running ? "polling" : "idle",
    `${tracker.snapshots || 0} collected snapshots`,
    `${trainingSnapshots} trainable snapshots`,
    `${games.live || 0} live games`,
    latest?.market_total_line !== null && latest?.market_total_line !== undefined
      ? `latest market ${latest.market_total_line}`
      : "",
    model ? `model ${model.sample_count} samples` : "collecting data",
    payload.last_error ? `error: ${payload.last_error}` : ""
  ]
    .filter(Boolean)
    .join(" | ");
}
