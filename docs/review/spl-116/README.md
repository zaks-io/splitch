# SPL-116 Review Evidence

Local-fleet Playwright artifacts for the read-complete Flag detail screen at
`/{orgSlug}/{appSlug}/{env}/flags/{flagKey}`. Every pair is one page captured under an
explicit light and an explicit dark color scheme. Nothing here touches shared-preview or
production; the fleet runs against a seeded local D1.

| Pair                                 | What it proves                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `flag-detail-dev-*`                  | `new-checkout` in `dev`: enabled, 2 of 2 Variants available, its own running Experiment.                                                               |
| `flag-detail-prod-*`                 | The same Flag in `prod`: disabled, 1 of 2 available. Same key, divergent Configuration, no client-side merging.                                        |
| `flag-detail-variant-availability-*` | `treatment` in `prod` is dimmed, labeled "Not available", and its `available in prod` toggle is off and disabled. Defined App-level, unavailable here. |
| `flag-detail-experiment-locked-*`    | The "Controlled by Experiment" banner, the per-field-group lock markers with their reason, and the kill switch carrying no lock.                       |
| `flag-detail-newly-created-*`        | A Flag created through the panel's own guided flow, with no fixture-seeded Flag Configuration: disabled, availability reported as "not narrowed".      |

Reproduce with `pnpm --filter @splitch/control-panel test:e2e flags.spec.ts`.
