#!/usr/bin/env node

import { liveTrackingConfig, LiveTrackingStore } from "./live-tracking-store.js";

const config = liveTrackingConfig();
const store = new LiveTrackingStore(config.dbPath);

try {
  const result = store.trainLatestModel(config.minSnapshots);
  console.log(
    JSON.stringify(
      {
        status: result.status,
        db_path: config.dbPath,
        trained_at: result.model.trained_at,
        sample_count: result.model.sample_count,
        game_count: result.model.game_count,
        effective_sample_count: result.model.effective_sample_count,
        metrics: result.model.metrics
      },
      null,
      2
    )
  );
} finally {
  store.close();
}
