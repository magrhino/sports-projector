import { DEFAULT_SETTINGS, type SportsProjectorSettings } from "../lib/settings.js";
import type { LiveTrackingConfig, LiveTrackingStore } from "./live-tracking-store.js";

export interface LiveAutoTrainingStatus {
  enabled: boolean;
  running: boolean;
  interval_seconds: number;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_success_at: string | null;
  last_skip_reason: string | null;
  last_error: string | null;
  last_trained_sample_count: number | null;
}

export type SettingsReader = () => SportsProjectorSettings;

export class LiveModelTrainingScheduler {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private running = false;
  private lastStartedAt: string | null = null;
  private lastFinishedAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastSkipReason: string | null = null;
  private lastError: string | null = null;
  private lastTrainedSampleCount: number | null = null;

  constructor(
    private readonly config: LiveTrackingConfig,
    private readonly store: LiveTrackingStore,
    private readonly readSettings: SettingsReader = () => DEFAULT_SETTINGS
  ) {}

  start(): void {
    if (this.started || !this.config.enabled) {
      return;
    }
    this.started = true;
    void this.tick();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async trainIfDue(): Promise<boolean> {
    if (this.running) {
      this.lastSkipReason = "Auto training is already running.";
      return false;
    }

    this.running = true;
    this.lastStartedAt = new Date().toISOString();
    try {
      const settings = this.readSettings();
      if (!settings.live_auto_training_enabled) {
        this.skip("Auto training is disabled.");
        return false;
      }
      if (!this.config.enabled) {
        this.skip("Live tracking is disabled.");
        return false;
      }

      const status = this.store.status(this.config.enabled, this.config.minSnapshots);
      if (!status.training.ready) {
        this.skip(
          `Need ${status.training.min_snapshots ?? "more"} effective game/time-bucket snapshots; found ${status.training.effective_snapshots} from ${status.training.snapshots} finalized snapshots.`
        );
        return false;
      }
      if (
        status.model?.effective_sample_count !== null &&
        status.model?.effective_sample_count !== undefined &&
        status.model.effective_sample_count >= status.training.effective_snapshots
      ) {
        this.skip(`No new effective snapshots since the latest ${status.model.effective_sample_count}-effective-snapshot model.`);
        return false;
      }

      const result = this.store.trainLatestModel(this.config.minSnapshots);
      this.lastSuccessAt = new Date().toISOString();
      this.lastTrainedSampleCount = result.model.sample_count;
      this.lastSkipReason = null;
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastSkipReason = null;
      return false;
    } finally {
      this.lastFinishedAt = new Date().toISOString();
      this.running = false;
    }
  }

  status(): LiveAutoTrainingStatus {
    const settings = this.safeSettings();
    return {
      enabled: settings.live_auto_training_enabled && this.config.enabled,
      running: this.running,
      interval_seconds: settings.live_training_interval_seconds,
      last_started_at: this.lastStartedAt,
      last_finished_at: this.lastFinishedAt,
      last_success_at: this.lastSuccessAt,
      last_skip_reason: this.lastSkipReason,
      last_error: this.lastError,
      last_trained_sample_count: this.lastTrainedSampleCount
    };
  }

  private tick(): void {
    void this.trainIfDue().finally(() => {
      if (!this.started) {
        return;
      }
      this.timer = setTimeout(() => {
        this.timer = null;
        this.tick();
      }, this.safeSettings().live_training_interval_seconds * 1000);
    });
  }

  private skip(reason: string): void {
    this.lastSkipReason = reason;
    this.lastError = null;
  }

  private safeSettings(): SportsProjectorSettings {
    try {
      return this.readSettings();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return DEFAULT_SETTINGS;
    }
  }
}

export function disabledAutoTrainingStatus(): LiveAutoTrainingStatus {
  return {
    enabled: false,
    running: false,
    interval_seconds: DEFAULT_SETTINGS.live_training_interval_seconds,
    last_started_at: null,
    last_finished_at: null,
    last_success_at: null,
    last_skip_reason: "Live tracking is disabled.",
    last_error: null,
    last_trained_sample_count: null
  };
}
