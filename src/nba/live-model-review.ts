#!/usr/bin/env node

import { prepareLiveTrackingDatabase } from "./live-db-recovery.js";
import { liveTrackingConfig, LiveTrackingStore } from "./live-tracking-store.js";

const config = liveTrackingConfig();
prepareLiveTrackingDatabase({
  dbPath: config.dbPath,
  mode: config.dbRecovery,
  sqliteBin: config.sqliteBin
});
const store = new LiveTrackingStore(config.dbPath);

try {
  console.log(JSON.stringify(store.reviewLatestModel(config.minSnapshots), null, 2));
} finally {
  store.close();
}
