import { Button } from "@splitch/ui/components/button";
import { Link } from "@tanstack/react-router";
import { docsPath } from "../docs/site";

/**
 * `secondary` defaults to llms.txt, the index that lists every page. A route
 * whose reader is looking for one specific missing thing points at the page
 * that would list it instead.
 */
export function DocNotFound({
  title,
  body,
  secondary = { href: "/llms.txt", label: "Machine-readable index" },
}: {
  title: string;
  body: string;
  secondary?: { href: string; label: string };
}) {
  return (
    <main className="px-4 py-14 sm:px-6 sm:py-16">
      <div className="mx-auto grid w-full max-w-4xl gap-6">
        <h1 className="font-bold font-display text-4xl text-foreground tracking-tight">
          {title}
          <span className="text-arm-control">.</span>
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground leading-relaxed">{body}</p>
        <div className="flex flex-wrap gap-3">
          <Button render={<Link to={docsPath.index()} />}>Docs index</Button>
          <Button render={<a href={secondary.href} />} variant="outline">
            {secondary.label}
          </Button>
        </div>
      </div>
    </main>
  );
}
