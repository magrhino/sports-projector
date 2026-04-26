import type { LiveNbaTracker } from "../nba/live-tracker.js";
import type { LiveTrackingConfig, LiveTrackingStore } from "../nba/live-tracking-store.js";

export interface LiveTrackingHttpContext {
  config: LiveTrackingConfig;
  store: LiveTrackingStore;
  tracker: LiveNbaTracker | null;
}

export function getLiveTrackingStatus(context: LiveTrackingHttpContext | null): { status: number; body: unknown } {
  if (!context) {
    return {
      status: 200,
      body: {
        running: false,
        polling: false,
        last_poll_at: null,
        last_error: null,
        tracker: {
          enabled: false,
          db_path: null,
          games: {
            tracked: 0,
            live: 0,
            finalized: 0
          },
          snapshots: 0,
          training: {
            snapshots: 0,
            min_snapshots: null,
            ready: false
          },
          latest_snapshot: null,
          model: null
        }
      }
    };
  }

  return {
    status: 200,
    body: context.tracker?.status() ?? {
      running: false,
      polling: false,
      last_poll_at: null,
      last_error: null,
      tracker: context.store.status(context.config.enabled, context.config.minSnapshots)
    }
  };
}

export function trainLiveModel(context: LiveTrackingHttpContext | null): { status: number; body: unknown } {
  if (!context) {
    return {
      status: 400,
      body: {
        error: "Live tracking storage is not configured."
      }
    };
  }

  try {
    return {
      status: 200,
      body: context.store.trainLatestModel(context.config.minSnapshots)
    };
  } catch (error) {
    return {
      status: 400,
      body: {
        error: error instanceof Error ? error.message : String(error),
        tracker: context.store.status(context.config.enabled, context.config.minSnapshots)
      }
    };
  }
}
