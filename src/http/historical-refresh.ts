import type { HistoricalRefreshScheduler } from "../nba/historical-refresh.js";

export interface HistoricalRefreshHttpContext {
  scheduler: HistoricalRefreshScheduler;
}

export function getHistoricalRefreshStatus(context: HistoricalRefreshHttpContext | null) {
  if (!context) {
    return {
      status: 200,
      body: {
        enabled: false,
        running: false,
        last_error: null
      }
    };
  }

  return {
    status: 200,
    body: context.scheduler.status()
  };
}
