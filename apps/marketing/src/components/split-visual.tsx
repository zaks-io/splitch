const arms = [
  {
    label: "Control",
    dotClass: "bg-arm-control",
    allocation: "50%",
    exposures: "6,241 exposures",
  },
  {
    label: "Treatment",
    dotClass: "bg-arm-treatment",
    allocation: "50%",
    exposures: "6,208 exposures",
  },
] as const;

/* The Split: one track of traffic becomes two arms. This is the only place
   both brand hues go loud, always at full saturation on bounded shapes. */
export function SplitVisual() {
  return (
    <figure
      aria-label="One traffic track splitting into a Control arm and a Treatment arm"
      className="grid min-w-0 gap-5 rounded-xl border border-border bg-card p-5 shadow-md sm:p-6"
    >
      <div className="flex items-center justify-between gap-3 font-mono text-xs">
        <span className="text-foreground">flag.checkout-cta</span>
        <span className="flex items-center gap-1.5 text-muted-foreground uppercase tracking-wide">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
          Run #7 · live
        </span>
      </div>

      <svg
        aria-hidden="true"
        className="h-auto w-full max-w-full"
        preserveAspectRatio="xMidYMid meet"
        fill="none"
        role="presentation"
        viewBox="0 0 560 240"
      >
        <path
          className="split-draw stroke-border"
          d="M8 120 H 176"
          pathLength={1}
          strokeLinecap="round"
          strokeWidth={8}
        />
        <path
          className="split-draw split-draw-late stroke-arm-control"
          d="M176 120 C 300 120 300 62 424 62 H 536"
          pathLength={1}
          strokeLinecap="round"
          strokeWidth={8}
        />
        <path
          className="split-draw split-draw-late stroke-arm-treatment"
          d="M176 120 C 300 120 300 178 424 178 H 536"
          pathLength={1}
          strokeLinecap="round"
          strokeWidth={8}
        />
        <circle className="fade-up fade-up-late fill-arm-control" cx={544} cy={62} r={8} />
        <circle className="fade-up fade-up-late fill-arm-treatment" cx={544} cy={178} r={8} />
      </svg>

      <div className="grid gap-3 sm:grid-cols-2">
        {arms.map((arm) => (
          <div className="rounded-lg border border-border bg-background p-4" key={arm.label}>
            <p className="flex items-center gap-2 font-mono text-muted-foreground text-xs uppercase tracking-wide">
              <span aria-hidden="true" className={`size-2 rounded-sm ${arm.dotClass}`} />
              {arm.label}
            </p>
            <p className="mt-2 font-display font-semibold text-2xl text-foreground">
              {arm.allocation}
            </p>
            <p className="mt-1 font-mono text-muted-foreground text-xs">{arm.exposures}</p>
          </div>
        ))}
      </div>

      <figcaption className="rounded-lg bg-muted px-4 py-3 font-mono text-sm">
        <span className="text-arm-treatment-foreground">+4.2%</span>
        <span className="text-muted-foreground"> [1.1, 7.3] · p=0.003 · </span>
        <span className="text-success-foreground">SRM healthy</span>
      </figcaption>
    </figure>
  );
}
