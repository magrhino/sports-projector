import type { IncomingMessage } from "node:http";
import type { LiveNbaTracker } from "../nba/live-tracker.js";
import { disabledAutoTrainingStatus, type LiveModelTrainingScheduler } from "../nba/live-training-scheduler.js";
import type { LiveTrackingConfig, LiveTrackingStore } from "../nba/live-tracking-store.js";
import { headerValue, isAuthorizedAdminRequest } from "./admin-auth.js";

const LIVE_MODEL_TRAIN_ACTION = "train-live-model";
const LIVE_MODEL_TRAIN_ACTION_HEADER = "x-sports-projector-action";

export interface LiveTrackingHttpContext {
  config: LiveTrackingConfig;
  store: LiveTrackingStore;
  tracker: LiveNbaTracker | null;
  trainer: LiveModelTrainingScheduler | null;
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
        },
        auto_training: disabledAutoTrainingStatus()
      }
    };
  }

  const body = context.tracker?.status() ?? {
    running: false,
    polling: false,
    last_poll_at: null,
    last_error: null,
    tracker: context.store.status(context.config.enabled, context.config.minSnapshots)
  };

  return {
    status: 200,
    body: {
      ...body,
      auto_training: context.trainer?.status() ?? disabledAutoTrainingStatus()
    }
  };
}

export function trainLiveModel(
  request: IncomingMessage,
  context: LiveTrackingHttpContext | null,
  options: { adminToken?: string | null } = {}
): { status: number; body: unknown } {
  if (!context) {
    return {
      status: 400,
      body: {
        error: "Live tracking storage is not configured."
      }
    };
  }

  if (!isAuthorizedTrainRequest(request, options.adminToken)) {
    return {
      status: 403,
      body: {
        error: "Live model training requires a local admin request."
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

function isAuthorizedTrainRequest(request: IncomingMessage, adminToken: string | null | undefined): boolean {
  if (headerValue(request, LIVE_MODEL_TRAIN_ACTION_HEADER) !== LIVE_MODEL_TRAIN_ACTION) {
    return false;
  }

  return isAuthorizedAdminRequest(request, adminToken);
}
