import { Toaster } from "@splitch/ui/components/sonner";
import { TooltipProvider } from "@splitch/ui/components/tooltip";
import { AppErrorPage } from "@splitch/ui/state/app-error-page";
import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { createRootRouteWithContext, HeadContent, Link, Scripts } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { reportRouteError } from "#lib/panel-observability";
import { initControlPanelClientSentry } from "#lib/panel-sentry-client";
import type { ControlPanelRouterContext } from "#lib/router-context";
import appCss from "../styles/app.css?url";

export const Route = createRootRouteWithContext<ControlPanelRouterContext>()({
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
  errorComponent: () => <AppErrorPage />,
  onError: ({ error }) => {
    reportRouteError("app", error, "__root__");
  },
  pendingComponent: PanelSkeleton,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  useEffect(() => {
    void initControlPanelClientSentry();
  }, []);

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <TooltipProvider>
          <div className="flex min-h-screen flex-col">
            <header className="border-border border-b bg-card">
              <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
                <Link
                  to="/"
                  activeOptions={{ exact: true }}
                  activeProps={{ className: "text-primary" }}
                  className="rounded-md font-semibold text-lg focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                >
                  splitch
                </Link>
                {/* Product destinations only. The Kitchen Sink is a local
                    visual-development surface, never a hosted destination. */}
                <div className="flex items-center gap-2">
                  <a
                    className="rounded-md border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                    href="/auth/logout"
                  >
                    sign out
                  </a>
                </div>
              </nav>
            </header>
            <div className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</div>
          </div>
          <Toaster />
        </TooltipProvider>
        <Scripts />
      </body>
    </html>
  );
}
