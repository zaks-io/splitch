import { AlertCircleIcon } from "lucide-react";

import { EmptyState } from "#state/empty-state";

type WidgetErrorStateProps = Omit<Parameters<typeof EmptyState>[0], "icon" | "title"> & {
  title?: Parameters<typeof EmptyState>[0]["title"];
};

function WidgetErrorState({
  description = "Keep working here; this panel can be retried later.",
  title = "Widget unavailable",
  ...props
}: WidgetErrorStateProps) {
  return (
    <EmptyState
      description={description}
      icon={<AlertCircleIcon className="size-4" />}
      title={title}
      {...props}
    />
  );
}

export { WidgetErrorState };
