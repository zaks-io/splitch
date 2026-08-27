import { Badge } from "@splitch/ui/components/badge";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DocBody } from "../components/doc-body";
import { cliDoc } from "../docs/cli";
import { docsPath } from "../docs/site";

export const Route = createFileRoute("/docs/cli")({
  head: () => ({
    meta: [
      { title: `${cliDoc.title} · splitch` },
      { name: "description", content: cliDoc.summary },
    ],
  }),
  component: CliDocRoute,
});

function CliDocRoute() {
  return (
    <main className="px-4 py-14 sm:px-6 sm:py-16">
      <div className="mx-auto grid w-full max-w-4xl gap-10">
        <header className="grid gap-4">
          <p className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              <Link to={docsPath.index()}>Docs</Link>
            </Badge>
            <Badge variant="outline">CLI</Badge>
            <Badge variant="outline">
              <a className="font-mono" href={docsPath.cliMarkdown()}>
                cli.md
              </a>
            </Badge>
          </p>
          <h1 className="font-bold font-display text-4xl text-foreground tracking-tight sm:text-5xl">
            {cliDoc.title}
            <span className="text-arm-control">.</span>
          </h1>
          <p className="max-w-2xl text-lg text-muted-foreground leading-relaxed">
            {cliDoc.summary}
          </p>
        </header>

        <DocBody blocks={cliDoc.blocks} />

        <p className="text-muted-foreground text-sm">
          Also available as{" "}
          <a
            className="font-mono text-arm-control underline underline-offset-4"
            href={docsPath.cliMarkdown()}
          >
            {docsPath.cliMarkdown()}
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
