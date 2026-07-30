# Event ingest is strictly defined ahead of time

**Status:** accepted

Metric Event and Web Event ingest is strict: event names and field names must be declared in one App-level Event Definition catalog before production rows are accepted. Each Event Definition has an immutable `metric` or `web` family selected at creation. Published Event Definition Versions are immutable, and event rows store the version that accepted them. JSON fields are allowed only when the Event Definition Version includes their JSON Schema. JSON object schemas are closed by default. Unknown event names, wrong-family routes, unknown Dimensions, schemaless JSON, unknown nested JSON keys, JSON that does not match schema, and Entity Profile fields fail loud and are not written to raw logs.

Scalar fields and Dimensions may declare immutable typed allowlists. Values outside an allowlist fail loud before any write, and changing an allowlist requires a new Event Definition Version. JSON fields express the equivalent through JSON Schema `enum`.

Number fields and Dimensions may also declare immutable inclusive minimum and maximum bounds. Non-finite or inverted bounds fail publication; out-of-range event values fail before any write.

## Considered options

- **Accept arbitrary events and infer the catalog later**: rejected because it creates noisy data, raises PII risk, and makes agent operation guess which facts are valid.
- **Require immutable Event Definition Versions before ingest**: accepted because it keeps analysis inputs intentional, validates browser Client Key writes at the edge, supports explicitly shaped JSON, gives agents a discoverable contract, and lets every event row trace back to the exact schema that accepted it.

## Consequences

The product needs one Event Definition authoring surface before Metric Event or Web Event ingest ships. Event Definitions are App-level, so dev/prod cannot drift into different event schemas. The immutable family routes each accepted event to the matching wire contract and datasource. Browser capture is disabled by default and has no wildcard mode; explicit SDK capture configuration never replaces authoritative ingest validation. Breaking field changes create a new Event Definition Version instead of mutating history. Metrics can reference only `metric` Event Definitions and named typed fields, not Web Events or ad hoc nested JSON paths.

Entity identity is also versioned schema. A `metric` Event Definition Version requires one Entity type and every event must match it. A `web` Event Definition Version uses an explicit null Entity type to prohibit identity, or a non-null Entity type to permit either anonymous events or a complete matching identity pair. Ingest never infers this privacy boundary from whether earlier rows happened to include identity.

Automatic capture configuration selects only one supported adapter source and one destination Event Definition name. It does not contain an attribute mapping or transformation language. Each adapter exposes a fixed output contract versioned with the browser SDK and drops all other source data before queueing. Custom event shaping remains an explicit `web.track()` call against its own published Event Definition.
