import { cloudflareWebAnalyticsScripts } from "@splitch/observability/cloudflare-web-analytics";
import { themeInitScript } from "@splitch/ui/components/theme-toggle";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SiteFooter } from "../components/site-footer";
import { SiteHeader } from "../components/site-header";
import { DOCS_ORIGIN } from "../docs/site";
import appCss from "../styles/app.css?url";

/**
 * Only the page-independent half of Open Graph lives here. Every route sets its
 * own `title` and `description`, and unfurlers fall back to those when `og:title`
 * and `og:description` are absent. Declaring the homepage's copy at the root
 * would instead stamp it onto every docs page.
 */
const openGraphMeta = [
  { property: "og:type", content: "website" },
  { property: "og:site_name", content: "splitch" },
  { property: "og:image", content: new URL("/og-card.png", DOCS_ORIGIN).href },
  { property: "og:image:width", content: "1200" },
  { property: "og:image:height", content: "630" },
  {
    property: "og:image:alt",
    content: "splitch · ship it behind a flag, prove it moved the number.",
  },
  { name: "twitter:card", content: "summary_large_image" },
];

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "splitch · feature flags and experiments, built for agents" },
      {
        name: "description",
        content:
          "Toggle features without redeploying your app. Compare models and product changes using user feedback. Manage Flags and Experiments through the CLI or MCP.",
      },
      ...openGraphMeta,
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", sizes: "32x32 16x16" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/site.webmanifest" },
    ],
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
