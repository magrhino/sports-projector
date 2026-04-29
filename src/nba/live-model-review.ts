#!/usr/bin/env node

import { liveTrackingConfig, LiveTrackingStore } from "./live-tracking-store.js";

const config = liveTrackingConfig();
const store = new LiveTrackingStore(config.dbPath);

try {
  console.log(JSON.stringify(store.reviewLatestModel(config.minSnapshots), null, 2));
} finally {
  store.close();
}
