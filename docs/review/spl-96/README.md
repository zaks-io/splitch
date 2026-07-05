# SPL-96 Review Evidence

These screenshots are PR-visible evidence for the control-panel `/kitchen-sink`
route after the `packages/ui` shadcn bootstrap.

- `kitchen-sink-light.png`: explicit `data-theme="light"` at 1440x1250.
- `kitchen-sink-dark.png`: explicit `data-theme="dark"` at 1440x1250.

System-dark parity was checked separately with `prefers-color-scheme: dark`,
`data-theme` cleared, and a `dark:bg-input/30` probe matching explicit dark.
