# Metric and Web Events use separate raw datasources

**Status:** accepted

Splitch keeps the Exposure pipeline raw log (`raw_events`) limited to Run-scoped Exposure and Activation rows, and stores Metric Events and Web Events in separate Tinybird raw datasources. This protects the load-bearing Exposure dedup, SRM, holdover, and Activation-gate path from flexible product-event and browser-telemetry shapes while still allowing Metric Events to join to Exposures during analysis.

## Considered options

- **One universal raw event datasource** — rejected because Metric Event properties and Web Event telemetry would widen the Exposure log and make the experiment denominator easier to break.
- **Separate raw datasources by event family** — accepted because each family has different identity, retention, privacy, and query contracts.
