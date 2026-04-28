import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { LiveNbaTracker } from "../nba/live-tracker.js";
import type { LiveTrackingConfig, LiveTrackingStore } from "../nba/live-tracking-store.js";

const LIVE_MODEL_TRAIN_ACTION = "train-live-model";
const LIVE_MODEL_TRAIN_ACTION_HEADER = "x-sports-projector-action";
const LIVE_MODEL_TRAIN_TOKEN_HEADER = "x-sports-projector-admin-token";

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

  if (isLoopbackAddress(request.socket.remoteAddress)) {
    return true;
  }

  const expectedToken = normalizeToken(adminToken);
  const providedToken = headerValue(request, LIVE_MODEL_TRAIN_TOKEN_HEADER);
  return expectedToken !== null && providedToken !== undefined && safeTokenEqual(providedToken, expectedToken);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  return address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1" || /^127\./.test(address);
}

function normalizeToken(token: string | null | undefined): string | null {
  const normalized = token?.trim();
  return normalized ? normalized : null;
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
