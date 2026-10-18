import { Button } from "@splitch/ui/components/button";
import type { ReactNode } from "react";

export const TEMPORARY_ENVIRONMENT_EXPERIMENT_REASON =
  "Experiment creation is unavailable because a Temporary Environment cannot host Experiments.";

export function TemporaryEnvironmentExperimentAction({
  children,
  describedBy,
}: {
  children: ReactNode;
  describedBy: string;
}) {
  return (
    <Button disabled aria-describedby={describedBy}>
      {children}
    </Button>
  );
}
