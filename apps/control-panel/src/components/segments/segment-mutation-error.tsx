import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import type { MutationErrorSurface } from "#lib/shared/api";

export function SegmentMutationError({ error }: { error: MutationErrorSurface | null }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertTitle>Segment operation failed</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}
