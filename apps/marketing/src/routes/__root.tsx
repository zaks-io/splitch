import { cloudflareWebAnalyticsScripts } from "@splitch/observability/cloudflare-web-analytics";
import { themeInitScript } from "@splitch/ui/components/theme-toggle";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SiteFooter } from "../components/site-footer";
import { SiteHeader } from "../components/site-header";
import appCss from "../styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "splitch · feature flags and experiments, agents first" },
      {
        name: "description",
        content: "Feature flags and A/B experimentation for agent-operated apps.",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
    scripts: [
      { children: themeInitScript },
      ...cloudflareWebAnalyticsScripts({
        platformTarget: import.meta.env.VITE_SPLITCH_PLATFORM_TARGET,
        siteToken: import.meta.env.VITE_CLOUDFLARE_WEB_ANALYTICS_TOKEN,
      }),
    ],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
});

function RootLayout() {
  return (
    <>
      <SiteHeader />
      <Outlet />
      <SiteFooter />
    </>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
