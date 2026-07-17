# Splitch does not store Entity Profiles

**Status:** accepted

Splitch stores hashed Entity identity plus event facts, not durable Entity Profiles. Email, name, phone, and similar profile fields remain in the customer's system; Metric Events and Web Events may carry event values and allowlisted Dimensions, but not profile fields.

## Considered options

- **Store Entity Profiles in Splitch** — rejected because it turns Splitch into a customer profile store, increases PII risk, and is not required for experiment analysis.
- **Store only hashed Entity identity and event facts** — accepted because Splitch can still join Exposures to Metric Events for analysis while keeping human-readable profile lookup with the customer.

## Consequences

Splitch dashboards can inspect an Entity when a user provides the Targeting Key and Splitch hashes it server-side, but Splitch does not show email/name labels from stored profile data.
