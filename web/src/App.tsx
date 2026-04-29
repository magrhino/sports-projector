import { FormEvent, useState, type ReactNode } from "react";
import packageInfo from "../../package.json";
import { useGameSearch, useLiveGames, useProjectionDetail, useSettingsDashboard } from "./hooks";
import {
  asRecord,
  displayTeamCode,
  formatDateTime,
  formatScoreStatus,
  historicalMetrics,
  isLiveGame,
  leagueLabel,
  liveMetrics,
  projectionNote,
  teamLogoUrl
} from "./format";
import type { Game, League, ProjectionMetric, ProjectionSection, Team } from "./types";
import type {
  HistoricalRefreshStatusPayload,
  ProjectorSettings,
  TrackerStatusPayload
} from "./types";

const leagues: League[] = ["nba", "nfl", "mlb", "nhl"];
const repositoryUrl = packageInfo.repository.url.replace(/\.git$/, "");
const repositoryLabel = repositoryUrl.replace(/^https:\/\/github\.com\//, "");

export function App() {
  const [view, setView] = useState<"workspace" | "settings">("workspace");

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Public sports research</p>
          <h1>Sports Projector</h1>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className={`nav-button${view === "workspace" ? " active" : ""}`}
            aria-pressed={view === "workspace"}
            onClick={() => setView("workspace")}
          >
            Workspace
          </button>
          <button
            type="button"
            className={`nav-button${view === "settings" ? " active" : ""}`}
            aria-pressed={view === "settings"}
            onClick={() => setView("settings")}
          >
            Settings
          </button>
        </div>
      </header>

      {view === "settings" ? <SettingsView /> : <WorkspaceView />}

      <AppFooter />
    </main>
  );
}

function AppFooter() {
  return (
    <footer className="app-footer" aria-label="Application information">
      <span aria-hidden="true" />
      <a className="github-link" href={repositoryUrl} target="_blank" rel="noreferrer">
        <svg className="github-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.36c-2.23.49-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.7 7.7 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.52-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z"
          />
        </svg>
        {repositoryLabel}
      </a>
      <span className="app-version">v{packageInfo.version}</span>
    </footer>
  );
}

function WorkspaceView() {
  const [team, setTeam] = useState("");
  const [league, setLeague] = useState<League>("nba");
  const liveGames = useLiveGames(league);
  const search = useGameSearch();
  const projections = useProjectionDetail(league);

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
    <>
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
    </>
  );
}

function SettingsView() {
  const dashboard = useSettingsDashboard();
  const settings = dashboard.settingsPayload?.settings;
  const tracker = dashboard.trackerPayload?.tracker;
  const trainingState = tracker?.training;
  const autoTraining = dashboard.trackerPayload?.auto_training;
  const trainDisabled = dashboard.training || !tracker?.enabled || !trainingState?.ready;

  return (
    <section className="settings-layout" aria-labelledby="settings-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Configuration</p>
          <h2 id="settings-title">Settings</h2>
        </div>
        <button type="button" className="secondary-button" disabled={dashboard.loading} onClick={() => void dashboard.load()}>
          Refresh
        </button>
      </div>

      <div className="status-grid">
        <div className="status-message" role="status" aria-live="polite">
          {dashboard.loading ? "Loading settings..." : dashboard.message || "\u00a0"}
        </div>
        {dashboard.error ? (
          <div className="error-message" role="alert">
            {dashboard.error}
          </div>
        ) : null}
      </div>

      <div className="settings-grid">
        <SettingsPanel title="Enhancements">
          <SettingsToggle
            label="Live learned corrections"
            checked={Boolean(settings?.live_enhancements_enabled)}
            disabled={!settings || dashboard.saving}
            onChange={(checked) => void dashboard.saveSettings({ live_enhancements_enabled: checked })}
          />
          <SettingsToggle
            label="Historical enhanced snapshots"
            checked={Boolean(settings?.historical_enhancements_enabled)}
            disabled={!settings || dashboard.saving}
            onChange={(checked) => void dashboard.saveSettings({ historical_enhancements_enabled: checked })}
          />
        </SettingsPanel>

        <SettingsPanel title="Live model">
          <SettingsToggle
            label="Automatic training"
            checked={Boolean(settings?.live_auto_training_enabled)}
            disabled={!settings || dashboard.saving}
            onChange={(checked) => void dashboard.saveSettings({ live_auto_training_enabled: checked })}
          />
          <label className="settings-field">
            <span>Training interval</span>
            <select
              value={settings?.live_training_interval_seconds ?? 3600}
              disabled={!settings || dashboard.saving}
              onChange={(event) =>
                void dashboard.saveSettings({ live_training_interval_seconds: Number(event.target.value) })
              }
            >
              <option value={900}>15 minutes</option>
              <option value={3600}>1 hour</option>
              <option value={21600}>6 hours</option>
              <option value={86400}>24 hours</option>
            </select>
          </label>
          <div className="metric-grid settings-metrics">
            <SettingsMetric label="Tracking" value={tracker?.enabled ? "Enabled" : "Disabled"} />
            <SettingsMetric label="Collected snapshots" value={formatCount(tracker?.snapshots)} />
            <SettingsMetric label="Trainable snapshots" value={formatCount(trainingState?.snapshots)} />
            <SettingsMetric label="Latest model" value={tracker?.model ? formatModelCount(tracker.model) : "None"} />
            <SettingsMetric label="Auto training" value={autoTraining?.enabled ? "Enabled" : "Disabled"} />
            <SettingsMetric label="Last auto result" value={autoTrainingStatus(autoTraining)} />
          </div>
          <button type="button" className="secondary-button" disabled={trainDisabled} onClick={dashboard.train}>
            {dashboard.training ? "Training" : "Train model"}
          </button>
        </SettingsPanel>

        <HistoricalSettingsPanel status={dashboard.historicalPayload} settings={settings} />
      </div>
    </section>
  );
}

function SettingsPanel(props: { title: string; children: ReactNode }) {
  return (
    <section className="settings-panel" aria-label={props.title}>
      <h3>{props.title}</h3>
      {props.children}
    </section>
  );
}

function SettingsToggle(props: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>{props.label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
    </label>
  );
}

function SettingsMetric(props: { label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-label">{props.label}</div>
      <div className="metric-value">{props.value}</div>
    </div>
  );
}

function HistoricalSettingsPanel(props: {
  status: HistoricalRefreshStatusPayload | null;
  settings: ProjectorSettings | undefined;
}) {
  const status = props.status;
  return (
    <SettingsPanel title="Historical refresh">
      <div className="metric-grid settings-metrics">
        <SettingsMetric label="Refresh" value={status?.enabled ? "Enabled" : "Disabled"} />
        <SettingsMetric label="Running" value={status?.running ? "Yes" : "No"} />
        <SettingsMetric label="Enhancements" value={props.settings?.historical_enhancements_enabled ? "Enabled" : "Disabled"} />
        <SettingsMetric label="Interval" value={formatInterval(status?.interval_seconds)} />
        <SettingsMetric label="Recent window" value={formatDays(status?.recent_days)} />
        <SettingsMetric label="Lookahead" value={formatDays(status?.lookahead_days)} />
        <SettingsMetric label="Last success" value={formatTimestamp(status?.last_success_at)} />
        <SettingsMetric label="Last error" value={status?.last_error || "None"} />
      </div>
    </SettingsPanel>
  );
}

function formatCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "-";
}

function formatModelCount(model: { sample_count?: number; game_count?: number | null }): string {
  if (typeof model.game_count === "number" && typeof model.sample_count === "number") {
    return `${model.game_count} games / ${model.sample_count} snapshots`;
  }
  return `${model.sample_count ?? 0} samples`;
}

function formatTimestamp(value: string | null | undefined): string {
  return value ? formatDateTime(value) : "-";
}

function formatDays(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value} day${value === 1 ? "" : "s"}` : "-";
}

function formatInterval(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  if (value % 3600 === 0) {
    const hours = value / 3600;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (value % 60 === 0) {
    const minutes = value / 60;
    return `${minutes} minutes`;
  }
  return `${value} seconds`;
}

function autoTrainingStatus(status: TrackerStatusPayload["auto_training"]): string {
  if (!status) {
    return "-";
  }
  if (status.last_error) {
    return status.last_error;
  }
  if (status.last_skip_reason) {
    return status.last_skip_reason;
  }
  if (status.last_success_at) {
    return `Trained ${formatTimestamp(status.last_success_at)}`;
  }
  return "Pending";
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
            <span className="live-game-matchup">
              <TeamSummary team={game.teams?.away} fallback="Away" />
              <span className="matchup-separator">at</span>
              <TeamSummary team={game.teams?.home} fallback="Home" />
            </span>
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
                  <TeamSummary team={game.teams?.away} fallback="Away" />
                  <span className="matchup-separator">at</span>
                  <TeamSummary team={game.teams?.home} fallback="Home" />
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
      <div className="team-cell">
        <TeamMark team={team} fallback="-" />
        <div className="team-copy">
          <div className="team-name">{team?.name || team?.abbreviation || "-"}</div>
          {team?.score !== null && team?.score !== undefined ? <div className="muted">Score: {team.score}</div> : null}
        </div>
      </div>
    </td>
  );
}

function TeamSummary(props: { team: Team | undefined; fallback: string }) {
  const label = displayTeamCode(props.team, props.fallback);
  return (
    <span className="team-summary">
      <TeamMark team={props.team} fallback={props.fallback} />
      <span className="team-summary-copy">
        <span className="team-summary-name">{label}</span>
        {props.team?.score !== null && props.team?.score !== undefined ? (
          <span className="team-summary-score">{props.team.score}</span>
        ) : null}
      </span>
    </span>
  );
}

function TeamMark(props: { team: Team | undefined; fallback: string }) {
  const logo = teamLogoUrl(props.team);
  const label = displayTeamCode(props.team, props.fallback);
  if (logo) {
    return <img className="team-icon" src={logo} alt="" loading="lazy" decoding="async" />;
  }

  return (
    <span className="team-icon team-icon-fallback" aria-hidden="true">
      {label.slice(0, 3).toUpperCase()}
    </span>
  );
}
