import { AlertCircleIcon } from "lucide-react";

import { ErrorPage } from "#state/error-page";

type AppErrorPageProps = Omit<Parameters<typeof ErrorPage>[0], "icon" | "statusCode">;

function AppErrorPage(props: AppErrorPageProps) {
  return (
    <ErrorPage
      description="The page failed to load."
      icon={<AlertCircleIcon className="size-5" />}
      statusCode="500"
      title="Page unavailable"
      {...props}
    />
  );
}

export { AppErrorPage };
