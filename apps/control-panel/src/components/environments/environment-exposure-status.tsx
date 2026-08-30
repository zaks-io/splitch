import { Alert, AlertAction, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";

type EnvironmentExposureStatusProps =
  | { state: "loading" }
  | { state: "not_received" }
  | { state: "received"; firstExposureAt: string }
  | { state: "error"; onRetry: () => void };

export function EnvironmentExposureStatus(props: EnvironmentExposureStatusProps) {
  if (props.state === "loading") {
    return (
      <Alert data-testid="exposure-status-loading">
        <AlertTitle>Checking for your first Exposure</AlertTitle>
        <AlertDescription>
          This check loads separately from the setup instructions.
        </AlertDescription>
      </Alert>
    );
  }

  if (props.state === "error") {
    return (
      <Alert data-testid="exposure-status-error" variant="destructive">
        <AlertTitle>Exposure status unavailable</AlertTitle>
        <AlertDescription>
          The status check failed. This does not mean the Environment is still waiting for an
          Exposure.
        </AlertDescription>
        <AlertAction>
          <Button onClick={props.onRetry} size="sm" type="button" variant="outline">
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }

  if (props.state === "received") {
    return (
      <Alert data-testid="exposure-status-received">
        <AlertTitle>First Exposure received</AlertTitle>
        <AlertDescription>
          Received at{" "}
          <time dateTime={props.firstExposureAt}>{formatTimestamp(props.firstExposureAt)}</time>.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert data-testid="exposure-status-not-received">
      <AlertTitle>Run your app</AlertTitle>
      <AlertDescription>
        Call <code>evaluate()</code> from your app with a real Targeting Key. Verify and test-eval
        do not record an Exposure, so this status keeps waiting until the real call arrives.
      </AlertDescription>
    </Alert>
  );
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}
