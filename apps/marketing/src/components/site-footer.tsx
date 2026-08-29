import { BrandMark } from "@splitch/ui/components/brand-mark";

/** The public repo. Every published package's `repository.url` points here. */
const REPO_URL = "https://github.com/zaks-io/splitch";

const columns = [
  {
    heading: "Product",
    links: [
      ["/#product", "Flags + Experiments"],
      ["/#agents", "Use it from your agent"],
      ["/#rigor", "Statistical rigor"],
      ["/quickstart", "Quickstart"],
    ],
  },
  {
    heading: "Reference",
    links: [
      ["/docs", "Docs"],
      ["/docs/sdk/install", "SDK guide"],
      ["/docs/errors", "Error catalog"],
      ["/llms.txt", "llms.txt"],
    ],
  },
  {
    heading: "Open source",
    links: [
      [REPO_URL, "splitch on GitHub"],
      [`${REPO_URL}/blob/main/LICENSE.md`, "Apache 2.0 license"],
      [`${REPO_URL}/issues`, "Report an issue"],
      ["https://app.splitch.dev", "Control panel"],
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
            Feature flags and A/B experimentation in one product. Apache 2.0.
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
        <p className="text-muted-foreground text-xs">
          A service of{" "}
          <a className="hover:text-foreground" href="https://zaks.io">
            Zaks.io, LLC
          </a>{" "}
          · Alpha. APIs may change before 1.0.
        </p>
        <p className="font-mono text-muted-foreground text-xs">the data must never lie</p>
      </div>
    </footer>
  );
}
