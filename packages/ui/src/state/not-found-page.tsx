import { SearchXIcon } from "lucide-react";

import { ErrorPage } from "#state/error-page";

type NotFoundPageProps = Omit<Parameters<typeof ErrorPage>[0], "icon" | "statusCode">;

function NotFoundPage(props: NotFoundPageProps) {
  return (
    <ErrorPage
      description="The requested page could not be found."
      icon={<SearchXIcon className="size-5" />}
      statusCode="404"
      title="Page not found"
      {...props}
    />
  );
}

export { NotFoundPage };
