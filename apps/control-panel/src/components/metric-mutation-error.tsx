import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import type { MutationErrorSurface } from "#lib/api";

export function MetricMutationError({ error }: { error: MutationErrorSurface | null }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertTitle>Metric operation failed</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}
