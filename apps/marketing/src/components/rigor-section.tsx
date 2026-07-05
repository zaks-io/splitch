const contracts = [
  "Sequential, always-valid inference by default",
  "Exposure is the analysis denominator",
  "SRM, CUPED, winsorization, and FDR are product contracts",
  "Bad config fails loud instead of falling back silently",
] as const;

export function RigorSection() {
  return (
    <section className="border-border border-t bg-muted px-6 py-20 sm:px-8">
      <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[1fr_1fr] lg:items-center">
        <div className="grid gap-5">
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
            Statistical rigor
          </p>
          <h2 className="font-display font-bold text-4xl text-foreground tracking-tight">
            Results have to trace back to facts.
          </h2>
          <p className="max-w-xl text-muted-foreground leading-relaxed">
            splitch treats analysis as an enforced product contract. A result should be auditable
            back to raw Exposure events, the Experiment Run, and the Metric definition that produced
            it.
          </p>
        </div>

        <div className="rigor-panel">
          <div className="grid gap-3">
            {contracts.map((contract) => (
              <div className="rigor-item" key={contract}>
                <span className="mt-1 h-2 w-2 rounded-sm bg-success" />
                <span>{contract}</span>
              </div>
            ))}
          </div>
          <div className="mt-8 border-border border-t pt-6">
            <p className="font-mono text-muted-foreground text-sm">
              +4.2% [1.1, 7.3] · p=0.003 · SRM healthy
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
