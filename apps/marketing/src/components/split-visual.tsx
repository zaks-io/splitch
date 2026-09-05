const arms = [
  {
    role: "Control",
    name: "Current model",
    detail: "The model you use today",
    dotClass: "bg-arm-control",
  },
  {
    role: "Treatment",
    name: "Candidate model",
    detail: "A cheaper model to try",
    dotClass: "bg-arm-treatment",
  },
] as const;

export function SplitVisual() {
  return (
    <figure
      aria-label="Example experiment comparing user feedback on a current model and a cheaper candidate model. No results are shown."
      className="grid min-w-0 gap-5 rounded-xl border border-border bg-card p-5 shadow-md sm:p-6"
    >
      <div className="flex items-center justify-between gap-3 font-mono text-xs">
        <span className="text-foreground">Model comparison</span>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-arm-treatment" />
          Example experiment
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
            <p className="mt-2 text-muted-foreground text-sm">{arm.detail}</p>
          </div>
        ))}
      </div>

      <figcaption className="rounded-lg bg-muted px-4 py-3 text-sm leading-relaxed">
        <span className="font-medium text-arm-treatment-foreground">
          Can a cheaper model compete?
        </span>{" "}
        <span className="text-muted-foreground">
          Collect user feedback and compare the results before deciding.
        </span>
      </figcaption>
    </figure>
  );
}
