import type { OverviewExperiments } from "@splitch/contracts";
import { WidgetErrorState } from "@splitch/ui/state/widget-error-state";
import { experimentsUnavailableCopy } from "#lib/overview-view";

/**
 * The degraded rendering for an Experiment card whose Analysis read failed.
 *
 * It never renders as "all clear", and it only offers a retry when the Worker
 * said one could help; otherwise the copy says plainly that refreshing will not
 * fix it.
 */
export function OverviewUnavailable({
  experiments,
  onRetry,
}: {
  experiments: Extract<OverviewExperiments, { status: "unavailable" }>;
  onRetry: () => void;
}) {
  const copy = experimentsUnavailableCopy(experiments);
  return (
    <div data-overview-state="unavailable" data-overview-reason={experiments.reason}>
      <WidgetErrorState
        className="border-none bg-transparent p-0"
        description={copy.description}
        title={copy.title}
        {...(copy.retryable
          ? {
              action: (
                <button
                  className="rounded-md border border-border px-3 py-1.5 font-medium text-sm hover:bg-accent"
                  onClick={onRetry}
                  type="button"
                >
                  Retry
                </button>
              ),
            }
          : {})}
      />
    </div>
  );
}
