import type { ReactNode } from "react";

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#components/empty";
import { cn } from "#lib/utils";

type EmptyStateProps = {
  action?: ReactNode;
  className?: string;
  description?: ReactNode;
  icon?: ReactNode;
  secondaryAction?: ReactNode;
  title: ReactNode;
};

function EmptyState({
  action,
  className,
  description,
  icon,
  secondaryAction,
  title,
}: EmptyStateProps) {
  return (
    <Empty className={cn("border border-border bg-card text-card-foreground", className)}>
      <EmptyHeader>
        {icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action || secondaryAction ? (
        <EmptyContent>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {action}
            {secondaryAction}
          </div>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

export { EmptyState };
