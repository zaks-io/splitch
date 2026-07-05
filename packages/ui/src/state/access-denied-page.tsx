import { LockIcon } from "lucide-react";

import { ErrorPage } from "#state/error-page";

type AccessDeniedPageProps = Omit<Parameters<typeof ErrorPage>[0], "icon" | "statusCode">;

function AccessDeniedPage(props: AccessDeniedPageProps) {
  return (
    <ErrorPage
      description="You do not have access to this page."
      icon={<LockIcon className="size-5" />}
      statusCode="403"
      title="Access denied"
      {...props}
    />
  );
}

export { AccessDeniedPage };
