# Mutation testing is advisory before it is a gate

**Status:** accepted

Coverage says code executed. It does not say the assertions were meaningful. splitch has several
domains where weak tests are dangerous even when line coverage is high: Evaluation, Assignment Store
policy, Exposure dedup, Run lifecycle, contract validation, and statistical analysis.

Mutation testing is the right pressure test for those seams, but it is expensive and noisy if applied
to the whole monorepo before the package layout and baseline tests exist. This ADR adopts StrykerJS
without making every PR wait on a young, unstable mutation score.

## Decision

Use StrykerJS for mutation testing, paired with Vitest.

The initial scope is critical domain logic only:

- Evaluation and non-exposing test-evaluation paths.
- Assignment Store replay/write policy.
- Exposure event creation, dedup keys, and quarantine behavior.
- Run lifecycle and material-edit rules.
- Contract validation and error response mapping.
- Statistical calculations and health diagnostics.

Do not run mutation testing over route shells, generated output, UI presentation components, type-only
barrels, test fixtures, or migration boilerplate. A surviving mutant in core domain logic means either
the test is weak, the code is equivalent under the domain model, or the implementation is carrying
dead complexity. Triage it explicitly instead of chasing a raw percentage.

## Tooling

StrykerJS is wired using the current packages, pinned at the root:

- `@stryker-mutator/core`
- `@stryker-mutator/vitest-runner`
- `@stryker-mutator/typescript-checker`

Shared policy lives in `stryker.base.json` at the repo root. Each opted-in package has a
`stryker.config.json` that `extends` the base and sets its own `mutate` scope, plus a
`test:mutation` package script (`stryker run`). Run everything with `pnpm test:mutation` (Turbo
fans out to opted-in packages) or one package with
`pnpm --filter @splitch/<pkg> test:mutation`. Agents use the per-package form to pressure-test
their own assertions before relying on them.

Initial opted-in scope: `@splitch/sdk` and `@splitch/contracts` (the critical domain logic that
exists today). Add a package by giving it a `stryker.config.json` + `test:mutation` script and a
`vitest.config.ts`; do not mutate route shells, generated output, or barrels.

Generated reports (`reports/mutation/`) and the incremental cache
(`reports/mutation/stryker-incremental.json`) are gitignored CI artifacts, not committed files.

## Gate policy

Mutation testing starts as advisory:

1. Local and normal PR gates keep running deterministic tests first.
2. Mutation testing runs on demand and in a scheduled CI job (`.github/workflows/mutation.yml`:
   `workflow_dispatch` + weekly cron), separate from the per-PR `ci` gate. `break` stays `null`.
3. The first stable runs establish per-package baselines for mutation score, runtime, and noisy
   equivalent mutants.
4. A hard PR gate may be enabled only for a scoped package after that package has a stable baseline
   and clear exclusion rules.

Critical survived mutants should become one of:

- A stronger unit, property, golden, or simulation test.
- A code simplification that removes the mutant surface.
- A narrow StrykerJS ignore with a reason tied to an equivalent mutant.

Do not treat StrykerJS as a replacement for the statistical rigor test families in
[0030](./0030-statistical-rigor-is-an-enforced-product-contract.md). It is an additional signal that
assertions fail when behavior changes.

## Done

Wired (advisory phase):

- [x] `pnpm test:mutation` runs StrykerJS against the scoped critical domains (sdk, contracts).
- [x] CI publishes mutation reports as artifacts from an on-demand / scheduled job
      (`.github/workflows/mutation.yml`), outside the per-PR `ci` gate.

Still open before any hard gate:

- [ ] Each included package has a documented baseline score, runtime, and exclusions (needs a real
      test suite first; the suite is empty today).
- [ ] Any hard gate names the package scope and threshold it enforces (`break` flips from `null` to
      a number for that one package).
- [ ] Survived mutants in critical domain logic are either tested, simplified away, or marked
      equivalent with a reason.

## Consequences

This adds a slower quality signal by design. The payoff is finding tests that only execute code
without proving the behavior splitch depends on.

The early advisory phase is intentional. A repo-wide mutation threshold before the domain packages
exist would create noise and teach the team to ignore the report. Scoped baselines keep the signal
useful.
