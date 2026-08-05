# Statistics audit suite

End-to-end audit of the assembled inference engine: coverage, any-time Type-I error, variance
reduction, cross-surface consistency, and reference values checked against published sources.

```
pnpm stats:audit
```

## CPU load

This suite is not in `verify:ci` because of what it costs to run. Vitest runs the five files in
parallel worker processes and every one of them is a Monte Carlo loop, so the suite will use every
core the machine has for its whole duration. Measured wall clock is roughly 2 minutes on an idle
machine and closer to 3 under contention; the single any-time Type-I test accounts for about 90
seconds of that on its own.

The practical consequence is that nothing else should be running against the same cores. When this
suite ran inside the CI graph it starved unrelated packages badly enough to push their tests past
the default 5s timeout, in a different package on each run. Run it on its own, by hand, before a
statistics change ships.

Its sources are type-checked on every CI run via `tsconfig.audit.json`, so a contract change fails
loudly instead of leaving the suite to rot between manual runs.

See [statistical-rigor-verification.md](../../../docs/spec/stats/statistical-rigor-verification.md)
for how this gate relates to `stats:unit`, `stats:golden`, `stats:property`, and `stats:simulation`.
