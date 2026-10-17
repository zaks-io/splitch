# Temporary Environments are expiring scratch Environments with their own token permission

**Status:** accepted

Agents work on one branch at a time in isolation, but every Environment they can reach is shared.
To test a change behind a Flag, an agent either edits `dev` under everyone else or keeps a second,
local set of Flag values that drifts from splitch. Both are wrong: the first breaks other agents,
the second tests a code path splitch never serves. A Personal Access Token that can change
Flag Configuration in any Environment also reaches production, because grants target Apps, not
Environments.

## Decision

An Environment is either **permanent** (every Environment today) or **temporary**, fixed at
creation. A Temporary Environment is a scratch copy of another Environment in the same App:

- It is created from a source Environment, and **Sync** can later replace its Flag Configurations
  from any Environment in the App, including `prod`. Sync is a whole-Environment copy into a
  Temporary Environment only. It copies the salt so rollout bucketing matches the source, and never
  copies a live Run.
- It expires at most 7 days after creation, and the expiry cannot be extended. Every Client Key and
  API Key minted in it carries that expiry. From that instant the data plane rejects them with
  `ENVIRONMENT_EXPIRED`, the Environment becomes read-only, and a scheduled teardown removes the
  Environment, its configuration, and its credentials.
- Its Environment Policy is always all-`allow`. It cannot host Experiments, receive a Conclusion's
  winner Promotion, or hold a Convex or Cloudflare integration installation, so nothing durable
  outside it ever references it and no locally cached snapshot outlives it. Its Flag changes are
  not sent to the Sentry integration, and App-level rollups ignore it.
- A new PAT permission, `temporary_environments`, authorizes the lifecycle of Temporary
  Environments (create, Sync, Flag Configuration edits, Promotion into them, SDK keys, delete) and
  nothing else. It is checked after the target Environment is resolved, so a token carrying only
  this permission is refused on every permanent Environment, and it never authorizes a stored
  Approval Request. Existing permissions keep their meaning on Temporary Environments.

## Considered options

- **Per-agent Targeting Rules in a shared `dev`.** Rejected. Every agent writes the same Flag
  Configuration, rule order collides, cleanup is manual, and isolation is a convention.
- **SDK-side local overrides.** Rejected. It productizes the drifting second Flag set, bypasses real
  evaluation, needs override plumbing in every runtime, and can leak into a production build. Unit
  tests can already use OpenFeature's in-memory provider.
- **An overlay Environment that stores only overrides and reads its parent live.** Deferred. It never
  drifts, but it puts a second read or a parent-change fan-out on the hot path. Snapshot plus Sync
  covers the need for a few days of work.
- **Environment-scoped grant targets (`env:<id>`).** Rejected for this need. An agent would need a
  new grant for every Environment it creates, and the grant would outlive the Environment. A
  permission bound to the Environment kind follows Environments as they come and go.
- **Extendable expiry.** Rejected. A fixed expiry lets credential cache entries carry it without
  rewrites, and recreating from the same source is one call.
- **Sending Temporary Environment changes to Sentry.** Rejected. Sentry's flag log has no
  Environment axis, so scratch toggles would appear beside production errors as if they were
  production changes. That misleads triage, which is worse than the omission.
- **Allowing integrations and propagating expiry into their snapshots.** Deferred. The Convex and
  Cloudflare runtimes evaluate stored snapshots locally with no expiry, and revoking an installation
  does not invalidate a snapshot already delivered. Refusing them keeps the 7-day guarantee true
  until a real need justifies extending both snapshot contracts.

## Consequences

- `environments` gains `expires_at` (non-null means temporary) and Sync provenance columns, and the
  Flag change log records the Environment kind at write time. The credential cache gains a v3
  payload carrying `expiresAt`. Data-plane readers ship before any writer emits it, and the Control
  Plane must not roll back past the release that creates Temporary Environments while any exist.
- `POST /apps/{app_id}/envs` gains an optional `temporary` body, and
  `POST /apps/{app_id}/envs/{environment_id}/sync` is the one new operation.
- Route contracts gain an opt-in marker for `temporary_environments`, enforced once in the shared
  path-selector resolution step rather than per handler.
- Each App holds at most 50 live Temporary Environments, which keeps them clear of the
  200-Environment attention budget even before the rollup excludes them. Sync refuses Apps above a
  tested Flag count before writing anything.
- Data an Exposure or event wrote under a Temporary Environment ages out under the existing
  datasource TTLs, the same as for any deleted Environment.
- Full design, rollout, and slices:
  [temporary-environments.md](../spec/control-plane/temporary-environments.md).
