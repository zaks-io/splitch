import { Badge } from "@splitch/ui/components/badge";
import { Button } from "@splitch/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ErrorCodeIndex } from "../components/error-code-index";
import { sdkTopics } from "../docs/sdk";

export const Route = createFileRoute("/docs/")({
  head: () => ({
    meta: [
      { title: "Docs · splitch" },
      {
        name: "description",
        content:
          "SDK guide and the full error catalog. Every failure code the API, SDK, and CLI can emit has a page.",
      },
    ],
  }),
  component: DocsIndexRoute,
});

function DocsIndexRoute() {
  return (
    <main className="px-4 py-14 sm:px-6 sm:py-16">
      <div className="mx-auto grid w-full max-w-4xl gap-12">
        <header className="grid gap-4">
          <p className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">Docs</Badge>
            <Badge variant="outline">
              <a className="font-mono" href="/llms.txt">
                llms.txt
              </a>
            </Badge>
          </p>
          <h1 className="font-bold font-display text-4xl text-foreground tracking-tight sm:text-5xl">
            Everything a failure can tell you<span className="text-arm-control">.</span>
          </h1>
          <p className="max-w-2xl text-lg text-muted-foreground leading-relaxed">
            Every page here is also served as plain markdown at the same URL with a{" "}
            <span className="font-mono text-foreground">.md</span> suffix, and{" "}
            <a className="text-arm-control underline underline-offset-4" href="/llms.txt">
              /llms.txt
            </a>{" "}
            indexes all of them. Building with an agent? Point it at{" "}
            <span className="font-mono text-foreground">mcp.splitch.dev</span> and it gets the same
            material without leaving the tools it already has.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button render={<Link to="/quickstart" />}>Quickstart</Button>
            <Button
              render={<Link params={{ topic: "install" }} to="/docs/sdk/$topic" />}
              variant="outline"
            >
              Install the SDK
            </Button>
          </div>
        </header>

        <section className="grid gap-4" id="sdk">
          <h2 className="font-display font-semibold text-2xl text-foreground tracking-tight">
            SDK
          </h2>
          <ul className="grid gap-3">
            {sdkTopics.map((topic) => (
              <li className="grid gap-1" key={topic.slug}>
                <Link
                  className="font-medium text-foreground underline underline-offset-4"
                  params={{ topic: topic.slug }}
                  to="/docs/sdk/$topic"
                >
                  {topic.title}
                </Link>
                <span className="text-muted-foreground text-sm leading-relaxed">
                  {topic.summary}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <ErrorCodeIndex />
      </div>
    </main>
  );
}
