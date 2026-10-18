import { buttonVariants } from "@splitch/ui/components/button";
import { EmptyState } from "@splitch/ui/state/empty-state";
import {
  TEMPORARY_ENVIRONMENT_EXPERIMENT_REASON,
  TemporaryEnvironmentExperimentAction,
} from "#components/experiments/temporary-environment-experiment-action";

/**
 * The calm Overview: a positive finding, not a blank. It still points at the next
 * thing to make, because an Environment with nothing in it and an Environment with
 * nothing wrong in it land here the same way (screen-inventory.md).
 */
export function OverviewCalmState({
  scopeHref,
  temporary,
}: {
  scopeHref: string;
  temporary: boolean;
}) {
  return (
    <EmptyState
      action={
        <a className={buttonVariants()} href={`${scopeHref}/flags`}>
          Create a Flag
        </a>
      }
      description={
        temporary ? (
          <>
            <span>No Flag changes were recorded recently. Create a Flag to try a change.</span>{" "}
            <span id="temporary-overview-experiments-reason">
              {TEMPORARY_ENVIRONMENT_EXPERIMENT_REASON}
            </span>
          </>
        ) : (
          <span>
            No Experiment is waiting on a decision, nothing is failing, and no Flag changes were
            recorded recently. Start a Flag, or run an Experiment on one you already have.
          </span>
        )
      }
      secondaryAction={
        temporary ? (
          <TemporaryEnvironmentExperimentAction describedBy="temporary-overview-experiments-reason">
            Create an Experiment
          </TemporaryEnvironmentExperimentAction>
        ) : (
          <a className={buttonVariants({ variant: "outline" })} href={`${scopeHref}/experiments`}>
            Create an Experiment
          </a>
        )
      }
      title="Nothing needs your attention"
    />
  );
}
