import { BrandMark } from "./brand-mark";

const columns = [
  {
    heading: "Product",
    links: [
      ["/#product", "Flags + Experiments"],
      ["/#rigor", "Statistical rigor"],
      ["/quickstart", "Quickstart"],
    ],
  },
  {
    heading: "Reference",
    links: [
      ["/docs", "Docs"],
      ["/docs/sdk/install", "SDK guide"],
      ["/docs#errors", "Error catalog"],
      ["/llms.txt", "llms.txt"],
    ],
  },
  {
    heading: "Operate",
    links: [
      ["https://app.splitch.dev", "Control panel"],
      ["https://mcp.splitch.dev", "MCP host"],
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-border border-t bg-background px-4 py-12 sm:px-6">
      <div className="mx-auto grid w-full max-w-6xl gap-10 sm:grid-cols-[1fr_auto_auto_auto] sm:gap-16">
        <div className="grid content-start gap-3">
          <BrandMark />
          <p className="max-w-xs text-muted-foreground text-sm leading-relaxed">
            One control plane for Flags, Experiments, Environments, and Metrics. Built for agents
            and humans.
          </p>
        </div>

        {columns.map((column) => (
          <nav
            aria-label={column.heading}
            className="grid content-start gap-3"
            key={column.heading}
          >
            <p className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-wide">
              {column.heading}
            </p>
            {column.links.map(([href, label]) => (
              <a className="text-foreground text-sm hover:text-primary" href={href} key={href}>
                {label}
              </a>
            ))}
          </nav>
        ))}
      </div>

      <div className="mx-auto mt-10 flex w-full max-w-6xl items-center justify-between border-border border-t pt-6">
        <p className="text-muted-foreground text-xs">splitch.dev</p>
        <p className="font-mono text-muted-foreground text-xs">the data must never lie</p>
      </div>
    </footer>
  );
}
