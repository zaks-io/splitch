import { BrandMark } from "./brand-mark";
import { CtaLink } from "./cta-link";

export function CtaSection() {
  return (
    <section className="cta-shell border-t px-6 py-20 sm:px-8">
      <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="grid gap-5">
          <BrandMark />
          <h2 className="max-w-3xl font-display font-bold text-4xl text-neutral-50 tracking-tight">
            Give agents the same flag and experiment surface humans get.
          </h2>
          <p className="max-w-2xl text-neutral-400 leading-relaxed">
            Start in the panel, then let agents operate through MCP with typed tools and the same
            authority model.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <CtaLink href="https://app.splitch.dev">Open panel signup</CtaLink>
          <CtaLink buttonClassName="inverse-cta" href="https://mcp.splitch.dev" variant="outline">
            Connect MCP
          </CtaLink>
        </div>
      </div>
    </section>
  );
}
