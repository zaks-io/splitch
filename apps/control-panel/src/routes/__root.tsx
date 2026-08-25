import { Toaster } from "@splitch/ui/components/sonner";
import { TooltipProvider } from "@splitch/ui/components/tooltip";
import { AppErrorPage } from "@splitch/ui/state/app-error-page";
import { PanelSkeleton } from "@splitch/ui/state/panel-skeleton";
import { createRootRouteWithContext, HeadContent, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { reportRouteError } from "#lib/panel-observability";
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
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <TooltipProvider>
          <div className="min-h-screen">{children}</div>
          <Toaster />
        </TooltipProvider>
        <Scripts />
      </body>
    </html>
  );
}
