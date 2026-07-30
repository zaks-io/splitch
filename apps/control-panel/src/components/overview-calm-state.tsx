import { buttonVariants } from "@splitch/ui/components/button";
import { EmptyState } from "@splitch/ui/state/empty-state";

/**
 * The calm Overview: a positive finding, not a blank. It still points at the next
 * thing to make, because an Environment with nothing in it and an Environment with
 * nothing wrong in it land here the same way (screen-inventory.md).
 */
export function OverviewCalmState({ scopeHref }: { scopeHref: string }) {
  return (
    <EmptyState
      action={
        <a className={buttonVariants()} href={`${scopeHref}/flags`}>
          Create a Flag
        </a>
      }
      description={
        <span>
          No Experiment is waiting on a decision, nothing is failing, and no Flag Configuration
          changed recently. Start a Flag, or run an Experiment on one you already have.
        </span>
      }
      secondaryAction={
        <a className={buttonVariants({ variant: "outline" })} href={`${scopeHref}/experiments`}>
          Create an Experiment
        </a>
      }
      title="Nothing needs your attention"
    />
  );
}
