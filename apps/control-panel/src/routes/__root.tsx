import { HeadContent, Link, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../styles/app.css?url";

const demoScope = {
  orgSlug: "demo-org",
  appSlug: "checkout-api",
  env: "dev",
};

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "splitch Control Panel" },
      {
        name: "description",
        content: "Control Panel shell for splitch feature flags and A/B experimentation.",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">
        <div className="flex min-h-screen flex-col">
          <header className="border-neutral-200 border-b bg-neutral-0">
            <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
              <Link
                to="/"
                activeOptions={{ exact: true }}
                activeProps={{ className: "text-brand-control-700" }}
                className="font-semibold text-lg"
              >
                splitch
              </Link>
              <Link
                to="/$orgSlug/$appSlug/$env"
                params={demoScope}
                activeProps={{ className: "border-brand-control-300 text-brand-control-700" }}
                className="rounded-md border border-neutral-200 px-3 py-2 text-sm"
              >
                demo scope
              </Link>
            </nav>
          </header>
          <div className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</div>
        </div>
        <Scripts />
      </body>
    </html>
  );
}
