import { BrandMark } from "./brand-mark";
import { CtaLink } from "./cta-link";

const stats = [
  ["Control", "cobalt", "50%"],
  ["Treatment", "chartreuse", "50%"],
] as const;

export function HeroSection() {
  return (
    <section className="hero-shell">
      <div className="mx-auto grid w-full max-w-6xl gap-14 px-6 py-6 sm:px-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(380px,0.95fr)] lg:items-center lg:py-8">
        <nav className="flex items-center justify-between gap-6 text-sm" aria-label="Primary">
          <a className="text-neutral-50" href="/">
            <BrandMark />
            <span className="sr-only">splitch home</span>
          </a>
          <div className="hidden items-center gap-6 font-medium text-neutral-300 sm:flex">
            <a className="hover:text-white" href="#flags-experiments">
              Product
            </a>
            <a className="hover:text-white" href="#quickstart">
              Quickstart
            </a>
            <a className="hover:text-white" href="https://mcp.splitch.dev">
              MCP
            </a>
          </div>
        </nav>

        <div className="grid gap-8 lg:col-start-1">
          <p className="font-mono text-neutral-400 text-xs uppercase tracking-wide">
            Feature flags and A/B experimentation for agents first
          </p>
          <div className="grid gap-6">
            <h1 className="max-w-4xl font-display font-bold text-5xl text-white tracking-tight sm:text-6xl lg:text-[76px] lg:leading-none">
              Ship the split. Measure the truth.
            </h1>
            <p className="max-w-2xl text-lg text-neutral-300 leading-normal">
              splitch gives agents and humans one control plane for Flags, Experiments,
              Environments, and Metrics, with rigor built into the workflow instead of bolted on
              after launch.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <CtaLink href="https://app.splitch.dev">Open panel signup</CtaLink>
            <CtaLink buttonClassName="inverse-cta" href="#quickstart" variant="outline">
              MCP quickstart
            </CtaLink>
          </div>
        </div>

        <div
          aria-label="Control and Treatment split"
          className="hero-split lg:col-start-2 lg:row-span-2 lg:row-start-1"
          role="img"
        >
          <div className="grid gap-5">
            <div className="flex items-center justify-between font-mono text-neutral-400 text-xs uppercase tracking-wide">
              <span>Control</span>
              <span>Treatment</span>
            </div>
            <div className="overflow-hidden rounded-full border border-white/10 shadow-lg">
              <div className="grid h-14 grid-cols-2">
                <div className="bg-arm-control" />
                <div className="bg-arm-treatment" />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {stats.map(([label, color, value]) => (
                <div className="rounded-md border border-white/10 bg-white/[0.04] p-4" key={label}>
                  <p className="font-mono text-neutral-400 text-xs uppercase tracking-wide">
                    {label}
                  </p>
                  <p className="mt-2 font-display font-semibold text-2xl text-white">{value}</p>
                  <p className="mt-1 text-neutral-400 text-sm">{color}</p>
                </div>
              ))}
            </div>
            <div className="rounded-md border border-white/10 bg-neutral-950/70 p-4 font-mono text-neutral-300 text-sm">
              <span className="text-brand-treatment-500">variant.checkout-v2</span>
              <span className="text-neutral-500"> resolves through </span>
              <span className="text-brand-control-400">prod</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
