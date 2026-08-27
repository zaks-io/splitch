import { Badge } from "@splitch/ui/components/badge";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { DocInline } from "../components/doc-body";
import { DocNotFound } from "../components/doc-not-found";
import {
  type DocumentedErrorCode,
  errorDocs,
  httpStatusForDocumentedCode,
  isDocumentedErrorCode,
  surfaceForCode,
  surfaceLabels,
} from "../docs/errors";
import { errorMarkdown } from "../docs/markdown";
import { markdownNotFound, markdownResponse, markdownSlug } from "../docs/serve-markdown";
import { DOCS_ORIGIN, docsPath } from "../docs/site";

export const Route = createFileRoute("/docs/error/$code")({
  // `.md` is a suffix on the same segment rather than its own route: a route
  // param cannot carry a literal suffix, so the handler splits it and defers to
  // the SSR component for every request that is not asking for markdown.
  server: {
    handlers: {
      GET: async ({ params, next }) => {
        const code = markdownSlug(params.code);
        if (code === null) return next();
        if (!isDocumentedErrorCode(code)) {
          return markdownNotFound(
            `"${code}" is not a splitch error code. Full index: ${DOCS_ORIGIN}/llms.txt`,
          );
        }
        return markdownResponse(errorMarkdown(code));
      },
    },
  },
  loader: ({ params }) => {
    if (!isDocumentedErrorCode(params.code)) throw notFound();
    return { code: params.code as DocumentedErrorCode };
  },
  head: ({ loaderData }) =>
    loaderData
      ? {
          meta: [
            { title: `${loaderData.code} · splitch errors` },
            { name: "description", content: errorDocs[loaderData.code].cause },
          ],
        }
      : {},
  notFoundComponent: () => (
    <DocNotFound
      title="No such error code"
      body="Every code the API, SDK, and CLI can emit has a page. If a shipped build printed this one, it is newer than this site: check the machine-readable index."
    />
  ),
  component: ErrorCodeRoute,
});

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{label}</dt>
      <dd className="font-mono text-foreground text-sm">{children}</dd>
    </div>
  );
}

function ErrorCodeRoute() {
  const { code } = Route.useLoaderData();
  const doc = errorDocs[code];
  const status = httpStatusForDocumentedCode(code);

  return (
    <main className="px-4 py-14 sm:px-6 sm:py-16">
      <div className="mx-auto grid w-full max-w-4xl gap-10">
        <header className="grid gap-4">
          <p className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              <Link to={docsPath.index()}>Docs</Link>
            </Badge>
            <Badge variant="outline">{surfaceLabels[surfaceForCode(code)]}</Badge>
            <Badge variant="outline">
              <a className="font-mono" href={docsPath.errorCodeMarkdown(code)}>
                {code}.md
              </a>
            </Badge>
          </p>
          <h1 className="break-words font-bold font-display font-mono text-3xl text-foreground tracking-tight sm:text-4xl">
            {code}
          </h1>
        </header>

        <dl className="grid gap-6 rounded-lg border border-border bg-muted/40 p-5 sm:grid-cols-2">
          {status !== null && <Fact label="HTTP status">{status}</Fact>}
          {doc.exitCode !== undefined && <Fact label="Exit code">{doc.exitCode}</Fact>}
          {doc.recommendedAction && <Fact label="Recommended action">{doc.recommendedAction}</Fact>}
          {doc.details && (
            <div className="grid gap-1 sm:col-span-2">
              <dt className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Details payload
              </dt>
              <dd>
                <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-foreground text-xs leading-relaxed">
                  <code>{doc.details}</code>
                </pre>
              </dd>
            </div>
          )}
        </dl>

        {doc.remediation && (
          <section className="grid gap-3">
            <h2 className="font-display font-semibold text-2xl text-foreground tracking-tight">
              Remediation
            </h2>
            <p className="max-w-2xl text-foreground leading-relaxed">{doc.remediation}</p>
          </section>
        )}

        <section className="grid gap-3">
          <h2 className="font-display font-semibold text-2xl text-foreground tracking-tight">
            Cause
          </h2>
          <p className="max-w-2xl text-muted-foreground leading-relaxed">
            <DocInline text={doc.cause} />
          </p>
        </section>

        <section className="grid gap-3">
          <h2 className="font-display font-semibold text-2xl text-foreground tracking-tight">
            Fix
          </h2>
          <p className="max-w-2xl text-muted-foreground leading-relaxed">
            <DocInline text={doc.fix} />
          </p>
        </section>

        {doc.related && doc.related.length > 0 && (
          <section className="grid gap-3 border-border border-t pt-8">
            <h2 className="font-medium text-foreground text-sm">Related codes</h2>
            <ul className="flex flex-wrap gap-2">
              {doc.related.map((related) => (
                <li key={related}>
                  <Link
                    className="rounded-md border border-border px-2 py-1 font-mono text-muted-foreground text-xs hover:text-foreground"
                    params={{ code: related }}
                    to="/docs/error/$code"
                  >
                    {related}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
