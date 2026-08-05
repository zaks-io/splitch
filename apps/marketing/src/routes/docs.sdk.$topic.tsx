import { Badge } from "@splitch/ui/components/badge";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { DocBody } from "../components/doc-body";
import { DocNotFound } from "../components/doc-not-found";
import { sdkTopicMarkdown } from "../docs/markdown";
import { findSdkTopic, sdkTopics } from "../docs/sdk";
import { markdownNotFound, markdownResponse, markdownSlug } from "../docs/serve-markdown";
import { docsPath } from "../docs/site";

export const Route = createFileRoute("/docs/sdk/$topic")({
  // `.md` is a suffix on the same segment rather than its own route: a route
  // param cannot carry a literal suffix, so the handler splits it and defers to
  // the SSR component for every request that is not asking for markdown.
  server: {
    handlers: {
      GET: async ({ params, next }) => {
        const slug = markdownSlug(params.topic);
        if (slug === null) return next();
        const topic = findSdkTopic(slug);
        if (!topic) {
          const known = sdkTopics.map((entry) => entry.slug).join(", ");
          return markdownNotFound(`No SDK topic named "${slug}". Topics: ${known}`);
        }
        return markdownResponse(sdkTopicMarkdown(topic));
      },
    },
  },
  loader: ({ params }) => {
    const topic = findSdkTopic(params.topic);
    if (!topic) throw notFound();
    return { topic };
  },
  head: ({ loaderData }) =>
    loaderData
      ? {
          meta: [
            { title: `${loaderData.topic.title} · splitch SDK` },
            { name: "description", content: loaderData.topic.summary },
          ],
        }
      : {},
  notFoundComponent: () => (
    <DocNotFound
      title="No such SDK topic"
      body="The SDK guide is split into topics, and the docs index lists every one of them."
    />
  ),
  component: SdkTopicRoute,
});

function SdkTopicRoute() {
  const { topic } = Route.useLoaderData();
  return (
    <main className="px-4 py-14 sm:px-6 sm:py-16">
      <div className="mx-auto grid w-full max-w-4xl gap-10">
        <header className="grid gap-4">
          <p className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              <Link to={docsPath.index()}>Docs</Link>
            </Badge>
            <Badge variant="outline">SDK</Badge>
            <Badge variant="outline">
              <a className="font-mono" href={docsPath.sdkTopicMarkdown(topic.slug)}>
                {topic.slug}.md
              </a>
            </Badge>
          </p>
          <h1 className="font-bold font-display text-4xl text-foreground tracking-tight sm:text-5xl">
            {topic.title}
            <span className="text-arm-control">.</span>
          </h1>
          <p className="max-w-2xl text-lg text-muted-foreground leading-relaxed">{topic.summary}</p>
        </header>

        <DocBody blocks={topic.blocks} />

        <nav className="grid gap-3 border-border border-t pt-8">
          <p className="font-medium text-foreground text-sm">Every SDK topic</p>
          <ul className="grid gap-2">
            {sdkTopics.map((entry) => (
              <li key={entry.slug}>
                <Link
                  className="text-muted-foreground text-sm underline underline-offset-4 hover:text-foreground"
                  params={{ topic: entry.slug }}
                  to="/docs/sdk/$topic"
                >
                  {entry.title}
                </Link>
                <span className="text-muted-foreground text-sm">: {entry.summary}</span>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </main>
  );
}
