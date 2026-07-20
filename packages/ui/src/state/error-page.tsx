import { AlertTriangleIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "#components/button";
import { Card, CardContent } from "#components/card";
import { cn } from "#lib/utils";

type ErrorPageProps = {
  action?: ReactNode;
  className?: string;
  description?: ReactNode;
  icon?: ReactNode;
  secondaryAction?: ReactNode;
  statusCode?: string;
  title?: ReactNode;
};

function ErrorPage({
  action,
  className,
  description = "Refresh the page or try again later.",
  icon = <AlertTriangleIcon className="size-5" />,
  secondaryAction,
  statusCode,
  title = "Something went wrong",
}: ErrorPageProps) {
  return (
    <main
      data-slot="error-page"
      className={cn("grid min-h-[60vh] place-items-center px-4 py-10", className)}
    >
      <Card className="w-full max-w-md">
        <CardContent className="grid gap-5 text-center">
          <div className="mx-auto grid size-10 place-items-center rounded-lg bg-destructive/10 text-destructive">
            {icon}
          </div>
          <div className="grid gap-2">
            {statusCode ? (
              <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
                {statusCode}
              </p>
            ) : null}
            <h1 className="font-semibold text-foreground text-xl">{title}</h1>
            {description ? (
              <p className="text-muted-foreground text-sm leading-relaxed">{description}</p>
            ) : null}
          </div>
          {action || secondaryAction ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
              {action ?? null}
              {secondaryAction ?? null}
            </div>
          ) : (
            <Button disabled variant="outline">
              No action available
            </Button>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

export { ErrorPage };
