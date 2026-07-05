import { buttonClassName, surfaceClassName } from "@splitch/ui";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

const service = "splitch-control-panel";
const demoScope = {
  orgSlug: "demo-org",
  appSlug: "checkout-api",
  env: "dev",
};

export const Route = createFileRoute("/")({
  component: IndexRoute,
});

function IndexRoute() {
  const [clicks, setClicks] = useState(0);

  return (
    <main className="grid gap-6">
      <section className="grid gap-4">
        <p className="font-mono text-neutral-500 text-xs uppercase tracking-wide">{service}</p>
        <div className="grid gap-2">
          <h1 className="font-semibold text-3xl text-neutral-900">Control Panel</h1>
          <p className="max-w-2xl text-base text-neutral-600">
            App and Environment scoped authoring for feature flags and A/B experimentation.
          </p>
        </div>
      </section>

      <section className={`${surfaceClassName} grid gap-5 border-neutral-200 bg-neutral-0`}>
        <div className="grid gap-1">
          <h2 className="font-semibold text-neutral-900 text-xl">Unauthenticated shell</h2>
          <p className="text-neutral-600 text-sm">
            Organization, App, and Environment scope are URL-visible from the first route slice.
          </p>
        </div>

        <div
          className="rounded-md border border-brand-control-300 bg-brand-control-50 p-4 text-brand-control-700 shadow-sm"
          data-theme-token-smoke="brand-control"
        >
          <p className="font-medium text-sm">Control Variant</p>
          <p className="text-sm">Reference Variant for preview.</p>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            className={`${buttonClassName} border-brand-control-300 bg-brand-control-500 text-neutral-0 hover:bg-brand-control-600`}
            data-hydration-counter={clicks}
            onClick={() => setClicks((currentClicks) => currentClicks + 1)}
            type="button"
          >
            Clicks {clicks}
          </button>
          <Link
            className={`${buttonClassName} border-neutral-200 bg-neutral-0 text-neutral-700 hover:bg-neutral-100`}
            params={demoScope}
            to="/$orgSlug/$appSlug/$env"
          >
            Open demo scope
          </Link>
        </div>
      </section>
    </main>
  );
}
