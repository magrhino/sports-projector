import { FormEvent, useState } from "react";
import { useGameSearch, useLiveGames, useLiveTrackerStatus, useProjectionDetail } from "./hooks";
import {
  asRecord,
  formatDateTime,
  formatLiveGameMatchup,
  formatScoreStatus,
  historicalMetrics,
  isLiveGame,
  leagueLabel,
  liveMetrics,
  projectionNote
} from "./format";
import type { Game, League, ProjectionMetric, ProjectionSection, Team } from "./types";

const leagues: League[] = ["nba", "nfl", "mlb", "nhl"];

export function App() {
  const [team, setTeam] = useState("");
  const [league, setLeague] = useState<League>("nba");
  const liveGames = useLiveGames(league);
  const search = useGameSearch();
  const projections = useProjectionDetail(league);
  const tracker = useLiveTrackerStatus();

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = team.trim();
    if (!trimmed) {
      projections.clear();
      search.fail("Enter a team name.");
      return;
    }
    projections.clear();
    void search.runSearch(trimmed, league);
  }

  function changeLeague(nextLeague: League) {
    setLeague(nextLeague);
    search.clear();
    projections.clear();
  }

  const searchedGames = search.result?.games || [];
  const selectedGameId = projections.selectedGame?.id;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Public sports research</p>
          <h1>Sports Projector</h1>
        </div>
        <div className="header-status" aria-label="Current league">
          <span className="status-dot" />
          {leagueLabel(league)} workspace
        </div>
      </header>

      <section className="control-panel" aria-label="Game search controls">
        <form className="search-form" onSubmit={submitSearch}>
          <label>
            <span>Team</span>
            <input
              value={team}
              onChange={(event) => setTeam(event.target.value)}
              name="team"
              type="search"
              placeholder="Celtics"
              autoComplete="off"
              required
            />
          </label>

          <label>
            <span>League</span>
            <select value={league} onChange={(event) => changeLeague(event.target.value as League)} name="league">
              {leagues.map((option) => (
                <option key={option} value={option}>
                  {leagueLabel(option)}
                </option>
              ))}
            </select>
          </label>

          <button className="primary-button" type="submit" disabled={search.loading}>
            {search.loading ? "Searching" : "Search"}
          </button>
        </form>

        <TrackerPanel
          message={tracker.message}
          onTrain={tracker.train}
          trainDisabled={tracker.trainDisabled}
          trainTitle={tracker.trainTitle}
          training={tracker.training}
        />
      </section>

      <LiveGamesPanel
        league={league}
        games={liveGames.games}
        loaded={liveGames.loaded}
        error={liveGames.error}
        selectedGameId={selectedGameId}
        onSelect={projections.selectGame}
      />

      <div className="status-grid">
        <div className="status-message" role="status" aria-live="polite">
          {search.status || "\u00a0"}
        </div>
        {search.error ? (
          <div className="error-message" role="alert">
            {search.error}
          </div>
        ) : null}
      </div>

      <div className="workspace-grid">
        <ResultsPanel
          games={searchedGames}
          source={search.result?.source || "espn"}
          title={search.result?.team?.name || "Search results"}
          selectedGameId={selectedGameId}
          onSelect={projections.selectGame}
          hasSearched={Boolean(search.result)}
        />

        <ProjectionPanel
          selectedGame={projections.selectedGame}
          payload={projections.payload}
          title={projections.title}
          meta={projections.meta}
          loadingMessage={projections.loadingMessage}
          error={projections.error}
          inFlight={projections.inFlight}
          onRefresh={projections.refresh}
        />
      </div>
    </main>
  );
}

function TrackerPanel(props: {
  message: string;
  training: boolean;
  trainDisabled: boolean;
  trainTitle: string;
  onTrain: () => void;
}) {
  return (
    <section className="tracker-card" aria-labelledby="tracker-title">
      <div>
        <p className="section-kicker">Live NBA tracker</p>
        <h2 id="tracker-title">Model readiness</h2>
        <p className="tracker-message">{props.message}</p>
      </div>
      <button type="button" className="secondary-button" disabled={props.trainDisabled} title={props.trainTitle} onClick={props.onTrain}>
        {props.training ? "Training" : "Train model"}
      </button>
    </section>
  );
}

function LiveGamesPanel(props: {
  league: League;
  games: Game[];
  loaded: boolean;
  error: string;
  selectedGameId: string | undefined;
  onSelect: (game: Game) => void;
}) {
  let body;
  if (!props.loaded) {
    body = <p className="muted">Loading {leagueLabel(props.league)} live games...</p>;
  } else if (props.error) {
    body = (
      <p className="muted">
        {leagueLabel(props.league)} live games unavailable: {props.error}
      </p>
    );
  } else if (props.games.length === 0) {
    body = <p className="muted">No live {leagueLabel(props.league)} games.</p>;
  } else {
    body = (
      <div className="live-games-list">
        {props.games.map((game) => (
          <button
            key={game.id}
            type="button"
            className={`live-game-button${props.selectedGameId === game.id ? " selected" : ""}`}
            aria-label={`Open projections for ${game.name || game.short_name || "live game"}`}
            aria-selected={props.selectedGameId === game.id}
            onClick={() => props.onSelect(game)}
          >
            <span className="live-game-matchup">{formatLiveGameMatchup(game)}</span>
            <span className="live-game-detail">{game.status?.detail || game.status?.description || "\u00a0"}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <section className="live-panel" aria-label={`Live ${leagueLabel(props.league)} games`}>
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Live board</p>
          <h2>{leagueLabel(props.league)} games</h2>
        </div>
        <span className="count-pill">{props.games.length}</span>
      </div>
      {body}
    </section>
  );
}

function ResultsPanel(props: {
  games: Game[];
  source: string;
  title: string;
  selectedGameId: string | undefined;
  hasSearched: boolean;
  onSelect: (game: Game) => void;
}) {
  return (
    <section className="results-panel" aria-labelledby="results-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Schedule search</p>
          <h2 id="results-title">{props.title}</h2>
        </div>
        <span className="count-pill">
          {props.games.length} game{props.games.length === 1 ? "" : "s"}
        </span>
      </div>

      {!props.hasSearched ? (
        <div className="empty-state">Search for a team to load public ESPN game results.</div>
      ) : props.games.length === 0 ? (
        <div className="empty-state">No games found.</div>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date/time</th>
                  <th>Away</th>
                  <th>Home</th>
                  <th>Score/status</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {props.games.map((game) => (
                  <tr
                    key={game.id}
                    className={props.selectedGameId === game.id ? "selected-row" : ""}
                    tabIndex={0}
                    role="button"
                    aria-label={`Open projections for ${game.name || game.short_name || "game"}`}
                    aria-selected={props.selectedGameId === game.id}
                    onClick={() => props.onSelect(game)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        props.onSelect(game);
                      }
                    }}
                  >
                    <td>{formatDateTime(game.start_time)}</td>
                    <TeamCell team={game.teams?.away} />
                    <TeamCell team={game.teams?.home} />
                    <td>
                      <div className="cell-stack">
                        <span>{formatScoreStatus(game)}</span>
                        {isLiveGame(game) ? <span className="live-badge">LIVE</span> : null}
                      </div>
                    </td>
                    <td className="source-cell">{props.source.toUpperCase()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mobile-results">
            {props.games.map((game) => (
              <button
                key={game.id}
                type="button"
                className={`result-card${props.selectedGameId === game.id ? " selected" : ""}`}
                aria-label={`Open projections for ${game.name || game.short_name || "game"}`}
                aria-selected={props.selectedGameId === game.id}
                onClick={() => props.onSelect(game)}
              >
                <span className="result-card-date">{formatDateTime(game.start_time)}</span>
                <span className="result-card-matchup">
                  {game.teams?.away?.name || game.teams?.away?.abbreviation || "Away"} at{" "}
                  {game.teams?.home?.name || game.teams?.home?.abbreviation || "Home"}
                </span>
                <span className="result-card-status">{formatScoreStatus(game)}</span>
                {isLiveGame(game) ? <span className="live-badge">LIVE</span> : null}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ProjectionPanel(props: {
  selectedGame: Game | null;
  payload: {
    live_projection?: ProjectionSection;
    historical_projection?: ProjectionSection;
  } | null;
  title: string;
  meta: string;
  loadingMessage: string;
  error: string;
  inFlight: boolean;
  onRefresh: () => void;
}) {
  return (
    <section className="projection-panel" aria-labelledby="projection-title">
      <div className="panel-heading projection-heading">
        <div>
          <p className="section-kicker">Projection detail</p>
          <h2 id="projection-title">{props.selectedGame ? props.title : "Select a game"}</h2>
          <p className="muted">{props.selectedGame ? props.meta : "Live and historical projections appear here."}</p>
        </div>
        <button type="button" className="secondary-button" disabled={!props.selectedGame || props.inFlight} onClick={props.onRefresh}>
          Refresh
        </button>
      </div>

      <div className="projection-status" role="status" aria-live="polite">
        {props.loadingMessage || "\u00a0"}
      </div>
      {props.error ? (
        <div className="error-message" role="alert">
          {props.error}
        </div>
      ) : null}

      <div className="projection-grid">
        <ProjectionCard title="Live projection" section={props.payload?.live_projection} kind="live" loading={Boolean(props.selectedGame && !props.payload)} />
        <ProjectionCard
          title="Historical projection"
          section={props.payload?.historical_projection}
          kind="historical"
          loading={Boolean(props.selectedGame && !props.payload)}
        />
      </div>
    </section>
  );
}

function ProjectionCard(props: {
  title: string;
  section: ProjectionSection | undefined;
  kind: "live" | "historical";
  loading: boolean;
}) {
  let content;
  const data = asRecord(props.section?.data);

  if (props.loading) {
    content = <p className="muted">Loading {props.kind} projection...</p>;
  } else if (!props.section) {
    content = <p className="muted">Select a game.</p>;
  } else if (props.section.status !== "ok") {
    content = <p className="muted">{props.section.error || "Projection unavailable."}</p>;
  } else if (!data) {
    content = <p className="muted">Projection unavailable.</p>;
  } else {
    const metrics: ProjectionMetric[] = props.kind === "live" ? liveMetrics(data) : historicalMetrics(data);
    const note = projectionNote(data, props.kind);
    content =
      metrics.length === 0 ? (
        <p className="muted">Projection unavailable.</p>
      ) : (
        <>
          <div className="metric-grid">
            {metrics.map((metric) => (
              <div className="metric" key={metric.label}>
                <div className="metric-label">{metric.label}</div>
                <div className="metric-value">{metric.value || "-"}</div>
              </div>
            ))}
          </div>
          {note ? <p className="projection-note">{note}</p> : null}
        </>
      );
  }

  return (
    <article className="projection-card">
      <h3>{props.title}</h3>
      {content}
    </article>
  );
}

function TeamCell(props: { team: Team | undefined }) {
  const team = props.team;
  return (
    <td>
      <div className="team-name">{team?.name || team?.abbreviation || "-"}</div>
      {team?.score !== null && team?.score !== undefined ? <div className="muted">Score: {team.score}</div> : null}
    </td>
  );
}
