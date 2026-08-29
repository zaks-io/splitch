/* The first screen has to answer "what does this thing do" without a glossary,
   so the figure states the outcome in plain words. Confidence intervals,
   p-values, and SRM live in the rigor section, where there is room to say what
   they mean. The rates are consistent: 4.8% lifted 4.2% is 5.0%. */
const arms = [
  {
    role: "Control",
    name: "Old checkout",
    rate: "4.8%",
    dotClass: "bg-arm-control",
  },
  {
    role: "Treatment",
    name: "New checkout",
    rate: "5.0%",
    dotClass: "bg-arm-treatment",
  },
] as const;

export function SplitVisual() {
  return (
    <figure
      aria-label="A Flag called new-checkout splits traffic evenly. 4.8% of users on the old checkout purchased, against 5.0% on the new one, so the new checkout wins by 4.2%."
      className="grid min-w-0 gap-5 rounded-xl border border-border bg-card p-5 shadow-md sm:p-6"
    >
      <div className="flex items-center justify-between gap-3 font-mono text-xs">
        <span className="text-foreground">new-checkout</span>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
          Live · 12,449 users
        </span>
      </div>

      <svg
        aria-hidden="true"
        className="h-auto w-full max-w-full"
        fill="none"
        preserveAspectRatio="xMidYMid meet"
        role="presentation"
        viewBox="0 40 560 160"
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
          <div className="rounded-lg border border-border bg-background p-4" key={arm.role}>
            <p className="flex items-center gap-2 font-mono text-muted-foreground text-xs uppercase tracking-wide">
              <span aria-hidden="true" className={`size-2 rounded-sm ${arm.dotClass}`} />
              {arm.role}
            </p>
            <p className="mt-2 font-medium text-foreground text-sm">{arm.name}</p>
            <p className="mt-2 font-display font-semibold text-2xl text-foreground">{arm.rate}</p>
            <p className="text-muted-foreground text-xs">purchased</p>
          </div>
        ))}
      </div>

      <figcaption className="rounded-lg bg-muted px-4 py-3 text-sm leading-relaxed">
        <span className="font-medium text-arm-treatment-foreground">New checkout wins.</span>{" "}
        <span className="text-muted-foreground">4.2% more purchases.</span>
      </figcaption>
    </figure>
  );
}
