const form = document.querySelector("#search-form");
const teamInput = document.querySelector("#team-input");
const leagueSelect = document.querySelector("#league-select");
const searchButton = document.querySelector("#search-button");
const statusEl = document.querySelector("#status");
const errorEl = document.querySelector("#error");
const resultsEl = document.querySelector("#results");
const resultsTitle = document.querySelector("#results-title");
const resultsCount = document.querySelector("#results-count");
const resultsBody = document.querySelector("#results-body");
const projectionDetailEl = document.querySelector("#projection-detail");
const projectionTitleEl = document.querySelector("#projection-title");
const projectionMetaEl = document.querySelector("#projection-meta");
const projectionStatusEl = document.querySelector("#projection-status");
const projectionErrorEl = document.querySelector("#projection-error");
const projectionRefreshButton = document.querySelector("#projection-refresh");
const projectionLiveEl = document.querySelector("#projection-live");
const projectionHistoricalEl = document.querySelector("#projection-historical");
const trackerStatusEl = document.querySelector("#tracker-status");
const trackerTrainButton = document.querySelector("#tracker-train");

let currentLeague = leagueSelect.value;
let selectedGame = null;
let selectedRow = null;
let liveRefreshTimer = null;
let trackerStatusTimer = null;
let projectionRequestInFlight = false;
let statusMessage = "";
let liveGames = [];
let liveGamesLoaded = false;
let liveGamesError = "";
let liveGamesRequestId = 0;
let trackerStatusRequestId = 0;

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const team = teamInput.value.trim();
  const league = leagueSelect.value;
  if (!team) {
    showError("Enter a team name.");
    return;
  }

  currentLeague = league;
  setLoading(true);
  void loadLiveGames(league);
  clearResults();

  try {
    const params = new URLSearchParams({ team, league });
    const response = await fetch(`/api/games/search?${params.toString()}`, {
      headers: { accept: "application/json" }
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Search failed.");
    }

    renderResults(payload);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    setLoading(false);
  }
});

leagueSelect.addEventListener("change", () => {
  currentLeague = leagueSelect.value;
  statusMessage = "";
  clearResults();
  void loadLiveGames(currentLeague);
});

projectionRefreshButton.addEventListener("click", () => {
  if (!selectedGame) {
    return;
  }

  void fetchProjection(selectedGame, isLiveGame(selectedGame) ? "live" : "all");
});

trackerTrainButton.addEventListener("click", async () => {
  trackerTrainButton.disabled = true;
  trackerStatusEl.textContent = "Training live model...";
  try {
    const response = await fetch("/api/nba/live-model/train", {
      method: "POST",
      headers: { accept: "application/json" }
    });
    const payload = await response.json();
    if (!response.ok) {
      const message = formatTrainingError(payload);
      if (payload.tracker) {
        renderTrackerStatus({
          running: false,
          polling: false,
          last_error: null,
          tracker: payload.tracker
        });
      }
      trackerStatusEl.textContent = message;
      return;
    }
    await loadTrackerStatus();
  } catch (error) {
    trackerStatusEl.textContent = error instanceof Error ? error.message : String(error);
    trackerTrainButton.disabled = false;
  }
});

void loadLiveGames(currentLeague);
void loadTrackerStatus();
trackerStatusTimer = window.setInterval(() => {
  void loadTrackerStatus();
}, 15000);

async function loadLiveGames(league) {
  const requestId = ++liveGamesRequestId;
  liveGamesError = "";
  liveGamesLoaded = false;
  liveGames = [];
  renderStatus();

  try {
    const params = new URLSearchParams({ league });
    const response = await fetch(`/api/games/live?${params.toString()}`, {
      headers: { accept: "application/json" }
    });
    const payload = await response.json();
    if (requestId !== liveGamesRequestId) {
      return;
    }
    if (!response.ok) {
      throw new Error(payload.error || "Unable to load live games.");
    }
    liveGames = Array.isArray(payload.games) ? sortGames(payload.games) : [];
    liveGamesLoaded = true;
  } catch (error) {
    if (requestId !== liveGamesRequestId) {
      return;
    }
    liveGames = [];
    liveGamesLoaded = true;
    liveGamesError = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestId === liveGamesRequestId) {
      renderStatus();
    }
  }
}

async function loadTrackerStatus() {
  const requestId = ++trackerStatusRequestId;
  try {
    const response = await fetch("/api/nba/live-tracking/status", {
      headers: { accept: "application/json" }
    });
    const payload = await response.json();
    if (requestId !== trackerStatusRequestId) {
      return;
    }
    if (!response.ok) {
      throw new Error(payload.error || "Unable to load tracker status.");
    }
    renderTrackerStatus(payload);
  } catch (error) {
    if (requestId !== trackerStatusRequestId) {
      return;
    }
    trackerStatusEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderTrackerStatus(payload) {
  const tracker = payload.tracker || {};
  const games = tracker.games || {};
  const latest = tracker.latest_snapshot;
  const model = tracker.model;
  const training = tracker.training || {};
  const trainingSnapshots = training.snapshots || 0;
  const minSnapshots = training.min_snapshots;
  trackerTrainButton.disabled = !tracker.enabled || !training.ready;
  trackerTrainButton.title = !tracker.enabled
    ? "Live tracking is disabled."
    : training.ready
      ? "Train the live correction model."
      : `Need ${minSnapshots || "more"} finalized trainable snapshots; found ${trainingSnapshots}.`;
  trackerStatusEl.textContent = [
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

function setLoading(isLoading) {
  searchButton.disabled = isLoading;
  statusMessage = isLoading ? "Loading..." : "";
  renderStatus();
  errorEl.hidden = true;
}

function showError(message) {
  statusMessage = "";
  renderStatus();
  errorEl.textContent = message;
  errorEl.hidden = false;
  resultsEl.hidden = true;
  clearProjectionDetail();
}

function clearResults() {
  errorEl.hidden = true;
  resultsBody.replaceChildren();
  resultsEl.hidden = true;
  clearProjectionDetail();
}

function renderResults(payload) {
  const games = sortGames(Array.isArray(payload.games) ? payload.games : []);
  const teamName = payload.team?.name || teamInput.value.trim();

  resultsTitle.textContent = teamName;
  resultsCount.textContent = `${games.length} game${games.length === 1 ? "" : "s"}`;
  resultsBody.replaceChildren(...games.map((game) => renderGameRow(game, payload.source || "espn")));
  resultsEl.hidden = false;
  statusMessage = games.length === 0 ? "No games found." : "";
  renderStatus();
}

function renderStatus() {
  const items = [];

  if (statusMessage) {
    const message = document.createElement("div");
    message.textContent = statusMessage;
    items.push(message);
  }

  const live = document.createElement("div");
  live.className = "live-games-status";
  if (!liveGamesLoaded) {
    live.textContent = `Loading ${leagueLabel(currentLeague)} live games...`;
  } else if (liveGamesError) {
    live.textContent = `${leagueLabel(currentLeague)} live games unavailable: ${liveGamesError}`;
  } else if (liveGames.length === 0) {
    live.textContent = `No live ${leagueLabel(currentLeague)} games.`;
  } else {
    const title = document.createElement("div");
    title.className = "live-games-title";
    title.textContent = `Live ${leagueLabel(currentLeague)} games`;

    const list = document.createElement("div");
    list.className = "live-games-list";
    list.append(...liveGames.map(renderLiveGameButton));
    live.append(title, list);
  }
  items.push(live);

  statusEl.replaceChildren(...items);
}

function renderLiveGameButton(game) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "live-game-button";
  button.setAttribute("aria-label", `Open projections for ${game.name || game.short_name || "live game"}`);
  button.addEventListener("click", () => {
    void selectGame(game, button);
  });

  const matchup = document.createElement("span");
  matchup.className = "live-game-matchup";
  matchup.textContent = formatLiveGameMatchup(game);

  const status = game.status?.detail || game.status?.description || "";
  button.append(matchup);
  if (status && status !== "-") {
    const statusEl = document.createElement("span");
    statusEl.className = "live-game-detail";
    statusEl.textContent = status;
    button.append(statusEl);
  }

  return button;
}

function renderGameRow(game, source) {
  const row = document.createElement("tr");
  row.className = "clickable-row";
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.setAttribute("aria-label", `Open projections for ${game.name || game.short_name || "game"}`);
  row.addEventListener("click", () => {
    void selectGame(game, row);
  });
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    void selectGame(game, row);
  });

  const sourceCell = cell(source.toUpperCase());
  sourceCell.classList.add("source-cell");
  row.append(
    cell(formatDateTime(game.start_time)),
    teamCell(game.teams?.away),
    teamCell(game.teams?.home),
    statusCell(game),
    sourceCell
  );
  return row;
}

async function selectGame(game, row) {
  if (selectedRow) {
    selectedRow.classList.remove("selected-row");
    selectedRow.removeAttribute("aria-selected");
  }

  selectedGame = game;
  selectedRow = row;
  selectedRow.classList.add("selected-row");
  selectedRow.setAttribute("aria-selected", "true");
  clearLiveRefreshTimer();
  resetProjectionDetail(game);

  if (currentLeague !== "nba") {
    showProjectionError("Projection detail is only available for NBA games.");
    renderSection(projectionLiveEl, { status: "error", error: "NBA-only projection route." }, "live");
    renderSection(projectionHistoricalEl, { status: "error", error: "NBA-only projection route." }, "historical");
    return;
  }

  await fetchProjection(game, "all");
  if (selectedGame?.id === game.id && isLiveGame(selectedGame)) {
    liveRefreshTimer = window.setInterval(() => {
      if (!selectedGame || projectionRequestInFlight) {
        return;
      }
      void fetchProjection(selectedGame, "live");
    }, 10000);
  }
}

async function fetchProjection(game, scope) {
  if (projectionRequestInFlight) {
    return;
  }

  projectionRequestInFlight = true;
  projectionRefreshButton.disabled = true;
  projectionErrorEl.hidden = true;
  projectionStatusEl.textContent = scope === "live" ? "Updating live projection..." : "Loading projections...";

  try {
    const params = new URLSearchParams({ event_id: game.id, scope });
    const response = await fetch(`/api/nba/projections?${params.toString()}`, {
      headers: { accept: "application/json" }
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Projection request failed.");
    }
    if (selectedGame?.id !== game.id) {
      return;
    }

    renderProjectionPayload(payload, scope);
  } catch (error) {
    if (selectedGame?.id === game.id) {
      showProjectionError(error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (selectedGame?.id === game.id) {
      projectionRefreshButton.disabled = false;
      projectionStatusEl.textContent = projectionStatusEl.textContent === "Loading projections..." ? "" : projectionStatusEl.textContent;
    }
    projectionRequestInFlight = false;
  }
}

function renderProjectionPayload(payload, scope) {
  const game = payload.game || selectedGame;
  if (game) {
    selectedGame = game;
  }
  if (!isLiveGame(game)) {
    clearLiveRefreshTimer();
  }
  projectionTitleEl.textContent = game?.short_name || game?.name || `ESPN event ${payload.event_id}`;
  projectionMetaEl.textContent = [
    formatScoreStatus(game),
    payload.event_id ? `ESPN event ${payload.event_id}` : null,
    payload.fetched_at ? `Updated ${formatDateTime(payload.fetched_at)}` : null,
    isLiveGame(game) ? "Auto-refreshes every 10 seconds" : null
  ]
    .filter(Boolean)
    .join(" | ");
  projectionStatusEl.textContent = payload.fetched_at ? `Updated ${formatDateTime(payload.fetched_at)}.` : "";

  if (payload.live_projection) {
    renderSection(projectionLiveEl, payload.live_projection, "live");
  }
  if (scope === "all" && payload.historical_projection) {
    renderSection(projectionHistoricalEl, payload.historical_projection, "historical");
  }
}

function renderSection(container, section, kind) {
  container.classList.remove("muted");
  container.replaceChildren();

  if (section.status !== "ok") {
    container.classList.add("muted");
    container.textContent = section.error || "Projection unavailable.";
    return;
  }

  const data = section.data || {};
  const metrics = kind === "live" ? liveMetrics(data) : historicalMetrics(data);
  if (metrics.length === 0) {
    container.classList.add("muted");
    container.textContent = "Projection unavailable.";
    return;
  }

  const grid = document.createElement("div");
  grid.className = "metric-grid";
  grid.append(...metrics.map((metric) => metricEl(metric.label, metric.value)));
  container.append(grid);

  const note = projectionNote(data, kind);
  if (note) {
    const noteEl = document.createElement("div");
    noteEl.className = "muted";
    noteEl.textContent = note;
    container.append(noteEl);
  }
}

function liveMetrics(data) {
  const projection = data.live_projection || {};
  const learned = projection.learned_projection;
  const teams = data.teams || {};
  const home = teams.home || {};
  const away = teams.away || {};
  const metrics = [
    {
      label: "Projected score",
      value: formatScoreLine(
        displayTeamCode(away, "Away"),
        projection.projected_away_score,
        displayTeamCode(home, "Home"),
        projection.projected_home_score
      )
    },
    { label: "Projected total", value: formatNumber(projection.projected_total) },
    { label: "Time left", value: formatGameTimeLeft(data.game_status, projection.model_inputs) },
    {
      label: "Current score",
      value: formatScoreLine(
        displayTeamCode(away, "Away"),
        away.score,
        displayTeamCode(home, "Home"),
        home.score
      )
    },
    { label: "Market total", value: formatNullableNumber(projection.market_total_line) },
    { label: "Over probability", value: formatProbability(projection.p_over) }
  ];
  if (learned) {
    metrics.push(
      {
        label: "Learned score",
        value: formatScoreLine(
          displayTeamCode(away, "Away"),
          learned.projected_away_score,
          displayTeamCode(home, "Home"),
          learned.projected_home_score
        )
      },
      { label: "Learned total", value: formatNumber(learned.projected_total) }
    );
  }
  return metrics;
}

function historicalMetrics(data) {
  const teams = data.teams || {};
  const homeName = teams.home || "Home";
  const awayName = teams.away || "Away";
  const marketComparison = data.market_comparison || {};
  const metrics = [
    {
      label: "Projected score",
      value: formatScoreLine(awayName, data.projected_away_score, homeName, data.projected_home_score)
    },
    { label: "Projected total", value: formatNumber(data.projected_total) },
    { label: "Home margin", value: formatNullableNumber(data.projected_home_margin) }
  ];
  if (typeof marketComparison.market_total === "number" && Number.isFinite(marketComparison.market_total)) {
    metrics.push({ label: "Pregame market total", value: formatNullableNumber(marketComparison.market_total) });
  }
  return metrics;
}

function projectionNote(data, kind) {
  if (kind === "live") {
    const quality = data.live_projection?.data_quality;
    const inputs = data.live_projection?.model_inputs || {};
    const marketDifference = data.live_projection?.difference_vs_market;
    const learned = data.live_projection?.learned_projection;
    if (!quality) {
      return "";
    }
    const warnings = Array.isArray(quality.warnings) ? quality.warnings : [];
    const recentWindow =
      typeof inputs.recent_points === "number" && typeof inputs.recent_minutes === "number"
        ? `Recent window: ${inputs.recent_points} pts / ${inputs.recent_minutes} min`
        : "";
    const marketNote =
      typeof marketDifference === "number" && Math.abs(marketDifference) >= 15
        ? `High variance: ${formatSignedNumber(marketDifference)} vs market`
        : "";
    return [
      quality.status ? `Status: ${quality.status}` : "",
      quality.recent_scoring_source ? `Source: ${quality.recent_scoring_source}` : "",
      recentWindow,
      learned ? `Learned model: ${learned.sample_count} samples` : "",
      marketNote,
      warnings[0] || ""
    ]
      .filter(Boolean)
      .join(" | ");
  }

  return [
    "Historical baseline; live in-game state and live market movement are excluded.",
    data.game_date ? `Game date: ${data.game_date}` : ""
  ]
    .filter(Boolean)
    .join(" | ");
}

function resetProjectionDetail(game) {
  projectionDetailEl.hidden = false;
  projectionTitleEl.textContent = game.short_name || game.name || "Projection";
  projectionMetaEl.textContent = formatScoreStatus(game);
  projectionStatusEl.textContent = "";
  projectionErrorEl.hidden = true;
  projectionRefreshButton.disabled = false;
  projectionLiveEl.className = "projection-content muted";
  projectionHistoricalEl.className = "projection-content muted";
  projectionLiveEl.textContent = "Loading live projection...";
  projectionHistoricalEl.textContent = "Loading historical projection...";
}

function showProjectionError(message) {
  projectionStatusEl.textContent = "";
  projectionErrorEl.textContent = message;
  projectionErrorEl.hidden = false;
}

function clearProjectionDetail() {
  clearLiveRefreshTimer();
  selectedGame = null;
  selectedRow = null;
  projectionRequestInFlight = false;
  projectionDetailEl.hidden = true;
  projectionErrorEl.hidden = true;
  projectionStatusEl.textContent = "";
  projectionLiveEl.replaceChildren();
  projectionHistoricalEl.replaceChildren();
}

function clearLiveRefreshTimer() {
  if (liveRefreshTimer !== null) {
    window.clearInterval(liveRefreshTimer);
    liveRefreshTimer = null;
  }
}

function teamCell(team) {
  const value = team?.name || team?.abbreviation || "-";
  const score = team?.score ?? null;
  const container = document.createElement("div");
  const name = document.createElement("div");
  name.className = "team";
  name.textContent = value;
  container.append(name);

  if (score !== null) {
    const scoreEl = document.createElement("div");
    scoreEl.className = "muted";
    scoreEl.textContent = `Score: ${score}`;
    container.append(scoreEl);
  }

  const tableCell = document.createElement("td");
  tableCell.append(container);
  return tableCell;
}

function statusCell(game) {
  const tableCell = document.createElement("td");
  const container = document.createElement("div");
  container.className = "cell-stack";

  const status = document.createElement("span");
  status.textContent = formatScoreStatus(game);
  container.append(status);

  if (isLiveGame(game)) {
    container.append(liveBadge());
  }

  tableCell.append(container);
  return tableCell;
}

function cell(value) {
  const tableCell = document.createElement("td");
  tableCell.textContent = value || "-";
  return tableCell;
}

function metricEl(label, value) {
  const container = document.createElement("div");
  container.className = "metric";

  const labelEl = document.createElement("div");
  labelEl.className = "metric-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("div");
  valueEl.className = "metric-value";
  valueEl.textContent = value || "-";

  container.append(labelEl, valueEl);
  return container;
}

function liveBadge() {
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = "LIVE";
  return badge;
}

function sortGames(games) {
  return [...games].sort((left, right) => {
    const rankDiff = gameStatusRank(left) - gameStatusRank(right);
    if (rankDiff !== 0) {
      return rankDiff;
    }

    const leftTime = Date.parse(left.start_time || "");
    const rightTime = Date.parse(right.start_time || "");
    return safeTime(leftTime) - safeTime(rightTime);
  });
}

function gameStatusRank(game) {
  if (isLiveGame(game)) {
    return 0;
  }
  if (game.status?.completed || game.status?.state === "post") {
    return 2;
  }
  return 1;
}

function safeTime(value) {
  return Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value;
}

function isLiveGame(game) {
  const state = String(game?.status?.state || "").toLowerCase();
  if (state === "in") {
    return true;
  }

  const status = `${game?.status?.description || ""} ${game?.status?.detail || ""}`.toLowerCase();
  return !game?.status?.completed && /\b(in progress|quarter|half|period|inning)\b/.test(status);
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatScoreStatus(game) {
  if (!game) {
    return "-";
  }

  const away = game.teams?.away?.score;
  const home = game.teams?.home?.score;
  const status = game.status?.detail || game.status?.description || "";

  if (away !== null && away !== undefined && home !== null && home !== undefined) {
    return status ? `${away}-${home} | ${status}` : `${away}-${home}`;
  }

  return status || "-";
}

function formatLiveGameMatchup(game) {
  const away = game.teams?.away;
  const home = game.teams?.home;
  return `${displayTeamCode(away, "Away")} ${formatNullableNumber(away?.score)} - ${displayTeamCode(
    home,
    "Home"
  )} ${formatNullableNumber(home?.score)}`;
}

function formatScoreLine(awayName, awayScore, homeName, homeScore) {
  return `${awayName} ${formatNullableNumber(awayScore)} - ${homeName} ${formatNullableNumber(homeScore)}`;
}

function displayTeamCode(team, fallback) {
  const name = String(team?.name || "");
  const abbreviation = String(team?.abbreviation || "");
  if (team?.id === "18" || name.toLowerCase().includes("knicks") || abbreviation.toUpperCase() === "NY") {
    return "NYK";
  }
  return abbreviation || name || fallback;
}

function formatNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "-";
}

function formatNullableNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "-";
}

function formatGameTimeLeft(status, inputs) {
  const clock = status?.clock || inputs?.clock;
  const period = status?.period || inputs?.period;
  const periodLabel = formatPeriodLabel(period);
  if (!clock) {
    return periodLabel || "-";
  }
  return periodLabel ? `${clock} ${periodLabel}` : String(clock);
}

function formatPeriodLabel(period) {
  if (typeof period !== "number" || !Number.isFinite(period)) {
    return "";
  }
  return period > 4 ? `OT${period - 4}` : `Q${period}`;
}

function formatProbability(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "-";
}

function formatTrainingError(payload) {
  const training = payload.tracker?.training;
  const collected = payload.tracker?.snapshots;
  if (training && typeof collected === "number") {
    return `${payload.error || "Training failed."} ${collected} collected snapshots, ${training.snapshots || 0} finalized trainable snapshots.`;
  }
  return payload.error || "Training failed.";
}

function leagueLabel(league) {
  return String(league || "").toUpperCase();
}

function formatSignedNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}
