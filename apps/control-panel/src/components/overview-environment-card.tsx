import type { EnvironmentPolicy } from "@splitch/contracts";
import { Badge } from "@splitch/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@splitch/ui/components/card";
import { ENVIRONMENT_POLICY_LABELS } from "#lib/environment-policy-labels";

export function OverviewEnvironmentCard({
  environmentKey,
  name,
  policy,
  scopeHref,
}: {
  environmentKey: string;
  name: string;
  policy: EnvironmentPolicy;
  scopeHref: string;
}) {
  return (
    <Card data-overview-card="environment">
      <CardHeader>
        <CardTitle>Environment at a glance</CardTitle>
        <CardDescription>
          {name} ({environmentKey}) — which writes need a confirmation here.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <ul className="grid gap-2">
          {ENVIRONMENT_POLICY_LABELS.map(([key, label]) => (
            <li
              className="flex items-center justify-between gap-2 text-sm"
              data-overview-policy={key}
              key={key}
            >
              <span className="text-muted-foreground">{label}</span>
              <Badge variant={policy[key] === "confirm" ? "default" : "secondary"}>
                {policy[key] === "confirm" ? "Confirm" : "Allow"}
              </Badge>
            </li>
          ))}
        </ul>
        <a
          className="text-sm underline underline-offset-4 hover:no-underline"
          href={`${scopeHref}/settings`}
        >
          Environment settings
        </a>
      </CardContent>
    </Card>
  );
}
