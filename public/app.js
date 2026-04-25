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

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const team = teamInput.value.trim();
  const league = leagueSelect.value;
  if (!team) {
    showError("Enter a team name.");
    return;
  }

  setLoading(true);
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

function setLoading(isLoading) {
  searchButton.disabled = isLoading;
  statusEl.textContent = isLoading ? "Loading..." : "";
  errorEl.hidden = true;
}

function showError(message) {
  statusEl.textContent = "";
  errorEl.textContent = message;
  errorEl.hidden = false;
  resultsEl.hidden = true;
}

function clearResults() {
  errorEl.hidden = true;
  resultsBody.replaceChildren();
  resultsEl.hidden = true;
}

function renderResults(payload) {
  const games = Array.isArray(payload.games) ? payload.games : [];
  const teamName = payload.team?.name || teamInput.value.trim();

  resultsTitle.textContent = teamName;
  resultsCount.textContent = `${games.length} game${games.length === 1 ? "" : "s"}`;
  resultsBody.replaceChildren(...games.map((game) => renderGameRow(game, payload.source || "espn")));
  resultsEl.hidden = false;
  statusEl.textContent = games.length === 0 ? "No games found." : "";
}

function renderGameRow(game, source) {
  const row = document.createElement("tr");
  row.append(
    cell(formatDateTime(game.start_time)),
    teamCell(game.teams?.away),
    teamCell(game.teams?.home),
    cell(formatScoreStatus(game)),
    cell(source.toUpperCase())
  );
  return row;
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

function cell(value) {
  const tableCell = document.createElement("td");
  tableCell.textContent = value || "-";
  return tableCell;
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
  const away = game.teams?.away?.score;
  const home = game.teams?.home?.score;
  const status = game.status?.detail || game.status?.description || "";

  if (away !== null && away !== undefined && home !== null && home !== undefined) {
    return status ? `${away}-${home} | ${status}` : `${away}-${home}`;
  }

  return status || "-";
}
