import { Badge } from "@splitch/ui/components/badge";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ErrorCodeIndex } from "../components/error-code-index";
import { documentedErrorCodes } from "../docs/errors";
import { docsPath } from "../docs/site";

export const Route = createFileRoute("/docs/errors")({
  head: () => ({
    meta: [
      { title: "Error codes · splitch" },
      {
        name: "description",
        content:
          "Every failure code the API, SDK, and CLI can emit, with its cause and a page carrying its fix.",
      },
    ],
  }),
  component: ErrorCodesRoute,
});

function ErrorCodesRoute() {
  return (
    <main className="px-4 py-14 sm:px-6 sm:py-16">
      <div className="mx-auto grid w-full max-w-4xl gap-10">
        <header className="grid gap-4">
          <p className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              <Link to={docsPath.index()}>Docs</Link>
            </Badge>
            <Badge variant="outline">Errors</Badge>
            <Badge variant="outline">
              <a className="font-mono" href={docsPath.errorsMarkdown()}>
                errors.md
              </a>
            </Badge>
          </p>
          <h1 className="font-bold font-display text-4xl text-foreground tracking-tight sm:text-5xl">
            Error codes<span className="text-arm-control">.</span>
          </h1>
          <p className="max-w-2xl text-lg text-muted-foreground leading-relaxed">
            All {documentedErrorCodes.length} codes any splitch surface can emit. Each resolves to a
            page at <span className="font-mono text-foreground">/docs/error/{"{code}"}</span>, and
            every error message prints that URL, so a failure you have never seen is one click from
            its cause and its fix.
          </p>
        </header>

        <ErrorCodeIndex />

        <p className="text-muted-foreground text-sm">
          Also available as{" "}
          <a
            className="font-mono text-arm-control underline underline-offset-4"
            href={docsPath.errorsMarkdown()}
          >
            {docsPath.errorsMarkdown()}
          </a>
          . Indexed from{" "}
          <a className="font-mono text-arm-control underline underline-offset-4" href="/llms.txt">
            /llms.txt
          </a>
          .
        </p>
      </div>
    </main>
  );
}
