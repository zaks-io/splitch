# Event ingest is strictly defined ahead of time

**Status:** accepted

Metric Event and Web Event ingest is strict: event names and field names must be declared in App-level Event Definitions before production rows are accepted. Published Event Definition Versions are immutable, and event rows store the version that accepted them. JSON fields are allowed only when the Event Definition Version includes their JSON Schema. JSON object schemas are closed by default. Unknown event names, unknown Dimensions, schemaless JSON, unknown nested JSON keys, JSON that does not match schema, and Entity Profile fields fail loud and are not written to raw logs.

## Considered options

- **Accept arbitrary events and infer the catalog later**: rejected because it creates noisy data, raises PII risk, and makes agent operation guess which facts are valid.
- **Require immutable Event Definition Versions before ingest**: accepted because it keeps analysis inputs intentional, validates browser Client Key writes at the edge, supports explicitly shaped JSON, gives agents a discoverable contract, and lets every event row trace back to the exact schema that accepted it.

## Consequences

The product needs an Event Definition authoring surface before Metric Event or Web Event ingest ships. Event Definitions are App-level, so dev/prod cannot drift into different event schemas. Breaking field changes create a new Event Definition Version instead of mutating history. Metrics can reference only declared Metric Events and named typed fields, not ad hoc nested JSON paths.
