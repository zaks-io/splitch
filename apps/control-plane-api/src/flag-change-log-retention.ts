/**
 * Age floor for the daily flag-change-log retention cron
 * (`runFlagChangeLogRetention` in scheduled.ts). Inventory health uses the
 * same constant so monthly churn completeness tracks what the cron may prune.
 */
export const FLAG_CHANGE_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
