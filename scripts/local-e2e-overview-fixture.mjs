/**
 * The Environments the App Overview is proven against, one per attention state.
 * Each state gets its own Environment. Calm also has its own App because
 * App-level Flag changes in another test must not make that fixture active.
 */
export const LOCAL_E2E_OVERVIEW_STATES = Object.freeze({
  experimentsUnavailable: {
    appSlug: "checkout-api",
    environmentKey: "dev",
    environmentId: "env_checkout_dev_e2e",
  },
  flagChanges: {
    appSlug: "checkout-api",
    environmentKey: "overview-changes",
    environmentId: "env_checkout_overview_e2e",
    recentFlagKey: "new-checkout",
    staleFlagKey: "checkout-srm",
  },
  calm: {
    appSlug: "overview-calm",
    environmentKey: "calm",
    environmentId: "env_checkout_calm_e2e",
  },
});

// The Overview's recently-changed window is relative to now, so the Flag
// change-log event that must land inside it needs a relative timestamp; a frozen
// one silently ages out of the window and the fixture stops proving anything.
const recentlyChangedAt = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
export const LOCAL_E2E_OVERVIEW_STALE_CHANGED_AT = "2026-06-01T00:00:00.000Z";

export const LOCAL_E2E_OVERVIEW_HISTORY_SEED = `
-- Trigger timestamps use wall-clock time even for historical fixture mutations.
-- Age those events so they cannot masquerade as recent activity.
UPDATE flag_change_events SET changed_at = '${LOCAL_E2E_OVERVIEW_STALE_CHANGED_AT}';
-- The Overview must follow the recorded event even though updated_at stays old.
UPDATE flag_configs SET enabled = 1 WHERE id = 'config_checkout_overview_e2e';
UPDATE flag_change_events SET changed_at = '${recentlyChangedAt}'
  WHERE app_id = 'app_checkout_e2e' AND environment_id = 'env_checkout_overview_e2e'
    AND flag_id = 'flag_checkout_e2e' AND target_type = 'flag_config';`;
