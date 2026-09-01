import { Badge } from "@splitch/ui/components/badge";
import { cn } from "@splitch/ui/lib/utils";
import { EnvironmentWarningDot } from "#components/environments/environment-warning-dot";

export function ActiveEnvironmentBadge({
  env,
  guarded = false,
}: {
  env: string;
  guarded?: boolean;
}) {
  return (
    <Badge
      className={cn("w-fit gap-1.5 bg-background", guarded && "border-warning/50")}
      data-active-environment={env}
      variant="outline"
    >
      {guarded ? <EnvironmentWarningDot /> : null}
      <span className="font-normal text-muted-foreground">Environment</span>
      <span>{env}</span>
    </Badge>
  );
}
