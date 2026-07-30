import type { AppOverviewResponse } from "@splitch/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewPage } from "./overview-page";

export const SCOPE_HREF = "/acme-labs/checkout-api/production";

const ENVIRONMENT: AppOverviewResponse["environment"] = {
  id: "env_prod",
  key: "production",
  name: "Production",
  policy: {
    variantAvailability: "confirm",
    targetingRolloutValue: "confirm",
    enabledState: "allow",
    startExperimentRun: "confirm",
  },
};

/**
 * A calm Overview, overridden per test.
 *
 * Shared by the page suite and the truncation suite so the two cannot drift into
 * disagreeing about what a default response looks like — the truncation
 * assertions only mean something against the same baseline the rest of the page
 * is checked on.
 */
export function renderOverview(overrides: Partial<AppOverviewResponse>): string {
  const overview: AppOverviewResponse = {
    appId: "app_checkout",
    environmentId: "env_prod",
    experiments: { status: "ok", needingDecision: [], failing: [], noData: [] },
    flagConfiguration: {
      recentlyChanged: [],
      windowDays: 7,
      changedCount: 0,
      readTruncated: false,
      readLimit: 50,
    },
    environment: ENVIRONMENT,
    ...overrides,
  };
  return renderToStaticMarkup(
    <OverviewPage
      env="production"
      onRetry={() => undefined}
      overview={overview}
      scopeHref={SCOPE_HREF}
    />,
  );
}

/** One in-window change, newest first, for tests that need a non-empty card. */
export function changes(
  count: number,
): AppOverviewResponse["flagConfiguration"]["recentlyChanged"] {
  return Array.from({ length: count }, (_unused, index) => ({
    flagId: `flag_${index}`,
    flagKey: `flag-key-${index}`,
    flagName: `Flag ${index}`,
    enabled: index % 2 === 0,
    updatedAt: new Date(Date.UTC(2026, 6, 19, 10, 0) - index * 60_000).toISOString(),
  }));
}
