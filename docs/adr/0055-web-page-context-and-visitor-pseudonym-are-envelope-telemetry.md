# Web page context and the visitor pseudonym are envelope telemetry

**Status:** accepted

Web Analytics needs the questions every analytics product answers first: which pages, from where,
by how many people. ADR-0042 deliberately bans free-form definition strings, so a page path can
never be an Event Definition field. Instead, every Web Event carries a bounded page-context
envelope, and the Event Ingest Worker derives a daily-rotating visitor pseudonym at accept time.

The envelope adds five `web_events` columns:

- `pathname` (caller-supplied): `location.pathname` only; `/`-prefixed, no query string, fragment,
  whitespace, or control characters, at most 512 characters;
- `referrer_hostname` (caller-supplied, nullable): the lowercase hostname of `document.referrer`,
  omitted when empty or same-origin;
- `country` (server-derived, nullable): uppercase ISO 3166-1 alpha-2 from Cloudflare request
  metadata;
- `device_class` (server-derived): `desktop`, `mobile`, `tablet`, or `unknown` from request
  User-Agent headers;
- `visitor_hash` (server-derived): HMAC with the App identity key, domain-separated by
  `web-visitor`, over the Environment, the UTC date of `server_received_at`, the client IP, and the
  User-Agent string.

Caller-supplied values participate in the retry fingerprint; server-derived values do not and are
sealed once at accept time, so retries resolve through their existing claim. The raw IP and
User-Agent are discarded after derivation and never persisted or logged.

Alongside this, the three built-in `web` Event Definitions (`$page_view`, `$web_vital`,
`$browser_error`) are Splitch-provisioned per App with null `entityType`; the reserved `$` prefix
is the ownership marker and user requests cannot create, edit, or delete `$`-prefixed definitions.

## Considered options

- **Page context as Event Definition dimensions**: rejected. ADR-0042 requires string Dimensions to
  declare closed machine-token allowlists, and page paths are unbounded by nature. Weakening the
  allowlist rule for one family would reopen the PII-in-strings hole the rule exists to close.
- **Full raw URLs**: rejected. Query strings routinely carry tokens, emails, and identifiers, which
  contradicts the no-direct-PII ingest boundary.
- **`localStorage` visitor identifier**: rejected. A persistent client-side identifier is a
  consent-triggering tracking mechanism and contradicts the no-`localStorage` stance in
  `web-event-identity.md`, while still failing across browsers and devices.
- **Sessions only, no visitor metric**: rejected. Unique visitors is the headline metric of every
  analytics surface; adding the column later would create a data epoch with zero uniques.
- **Daily-salted server-side hash**: accepted. No client storage, nothing persisted that can be
  reversed to an IP, exact uniques within a UTC day, approximate upper bound across days. The
  "daily salt" is the UTC date inside an HMAC keyed by the existing immutable App identity key, so
  no salt storage or rotation infrastructure exists and an App identity reset unlinks all history.

## Consequences

Top-pages, referrer, country, and device breakdowns work for every event without user
configuration, and per-page Web Vitals and custom-event breakdowns come free because the envelope
rides every Web Event. Visitor counts are exact per UTC day and an upper bound across days; the
read surface states this instead of hiding it. A session spanning UTC midnight counts as two
visitors. Page-context provenance is advisory, like `captureSource`: a direct Client Key caller can
lie about its pathname, and the analytics surface is exploratory rather than evidentiary. The
canonical delivery tuple, `deduped_web_events_state`, and the overview read contract all grow the
five values, which is free while `web_events` remains unimplemented.
