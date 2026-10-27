# Statistics audit suite

End-to-end audit of the assembled inference engine: coverage, any-time Type-I error, variance
reduction, cross-surface consistency, and reference values checked against published sources.

```bash
pnpm stats:audit
```

## CPU load

This suite is not in `verify:ci` because of what it costs to run. Vitest runs the files in
parallel worker processes. The root `pnpm stats:audit` command caps them at two workers,
so the suite can occupy two cores for much of its duration. Several tests run Monte Carlo loops.
Measured wall clock is roughly 2 minutes on an idle machine and closer to 3 under contention; the single any-time Type-I test accounts for about 90
seconds of that on its own.

Avoid running it alongside other CPU-heavy jobs or tests that measure elapsed time. Run it on its
own, by hand, before a statistics change ships.

Its sources are type-checked on every CI run via `tsconfig.audit.json`, so a contract change fails
loudly instead of leaving the suite to rot between manual runs.

See [statistical-rigor-verification.md](../../../docs/spec/stats/statistical-rigor-verification.md)
for how this gate relates to `stats:unit`, `stats:golden`, `stats:property`, and `stats:simulation`.
