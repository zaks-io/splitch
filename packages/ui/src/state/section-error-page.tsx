import { AlertTriangleIcon } from "lucide-react";

import { ErrorPage } from "#state/error-page";

type SectionErrorPageProps = Omit<Parameters<typeof ErrorPage>[0], "icon" | "statusCode">;

function SectionErrorPage(props: SectionErrorPageProps) {
  return (
    <ErrorPage
      description="This section failed to load."
      icon={<AlertTriangleIcon className="size-5" />}
      statusCode="500"
      title="Section unavailable"
      {...props}
    />
  );
}

export { SectionErrorPage };
