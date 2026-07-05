import type { ReactNode } from "react";
import { RefreshCwIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "#components/alert";
import { cn } from "#lib/utils";

type StaleDataToastProps = {
  action?: ReactNode;
  className?: string;
  description?: ReactNode;
  title?: ReactNode;
};

function StaleDataToast({
  action,
  className,
  description = "Refresh to load the latest version.",
  title = "Data may be out of date",
}: StaleDataToastProps) {
  return (
    <Alert
      data-slot="stale-data-toast"
      className={cn("border-warning/30 bg-warning-muted text-warning-foreground", className)}
    >
      <RefreshCwIcon className="size-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="text-warning-foreground/90">{description}</AlertDescription>
      {action ? <div data-slot="alert-action">{action}</div> : null}
    </Alert>
  );
}

export { StaleDataToast };
