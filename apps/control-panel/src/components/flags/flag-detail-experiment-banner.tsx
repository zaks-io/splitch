import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";

/**
 * "Controlled by Experiment X" — shown only while a running Experiment owns some
 * of this Flag's fields. It links to the owning Experiment and states the one way
 * out, because a locked field with no escape route is a dead end. The kill switch
 * exemption is spelled out here so an operator reading the banner during an
 * incident knows they can still turn the Flag off.
 */
export function FlagDetailExperimentBanner(props: {
  experiment: { id: string; name: string };
  scopeHref: string;
}) {
  const href = `${props.scopeHref}/experiments/${encodeURIComponent(props.experiment.id)}`;

  return (
    <Alert data-flag-experiment-banner={props.experiment.id}>
      <AlertTitle className="font-medium text-sm">
        Controlled by Experiment{" "}
        <a className="underline underline-offset-4 hover:no-underline" href={href}>
          {props.experiment.name}
        </a>
      </AlertTitle>
      <AlertDescription className="text-muted-foreground text-sm leading-6">
        The Variant set and Targeting Rules it owns are read-only. To change them, end the
        Experiment. The Serving toggle below stays available.
      </AlertDescription>
    </Alert>
  );
}
