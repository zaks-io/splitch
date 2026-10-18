import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { changedAtLabel } from "#lib/overview/overview-view";
import type { EnvironmentScope } from "#lib/shared/loader-context";

export function TemporaryEnvironmentNotice({
  environment,
  environments,
}: {
  environment: EnvironmentScope;
  environments: readonly EnvironmentScope[];
}) {
  if (!environment.temporary) return null;
  const { expiresAt, syncedFromEnvironmentId } = environment.temporary;
  const source = environments.find(
    (candidate) => candidate.environmentId === syncedFromEnvironmentId,
  );
  return (
    <Alert>
      <AlertTitle>Temporary Environment</AlertTitle>
      <AlertDescription>
        <p>
          Expires <time dateTime={expiresAt}>{changedAtLabel(expiresAt)}</time>.
        </p>
        <p>Sync source: {source ? source.name : "Environment no longer available"}.</p>
      </AlertDescription>
    </Alert>
  );
}
