# Control Panel navigation redesign

Status: agreed 2026-08-21; Slice 1 shipped 2026-08-21 (#393); Slices 2 to 4 implemented. Clickable mocks
that this doc describes live outside the repo (`~/.t3/userdata/attachments/splitch-nav-mocks`, served
locally); this doc is the durable record. When it disagrees with `navigation-and-ia.md` or
`screen-inventory.md`, this doc wins and those two are amended as each slice ships.

## Why

Agents (CLI, MCP) are the primary operator. The panel is the human surface, and it should make the
happy paths short. The shipped panel is correct but bog-standard and click-heavy. Measured against a
cold landing at `/`:

| Task                                  | Clicks today                   | Root cause                                                                                                                                                |
| ------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create a Flag                         | 5, and you must pick an env    | `/` is a chooser, `/{org}` is a card grid whose App name is a label, the only way in is an Environment link (`app-list-card.tsx`, `environment-link.tsx`) |
| Flip a Flag                           | 5 + toggle                     | Flags list shows Enabled as a Badge, no inline control (`flags-table-row.tsx`)                                                                            |
| Promote dev to prod                   | 6+                             | The Promote entry lives on the TARGET env's Flag detail only (`flag-detail-page.tsx` `data-flag-promote-entry`)                                           |
| Members or Billing from inside an App | impossible without the URL bar | Two shells; the App shell has no link to `/`, `/{org}`, Members, Billing, or Sign out (`app-shell.tsx`, `org-shell.tsx`)                                  |
| Switch App, keep your section         | lost                           | App switcher drops to the Overview (`app-shell-switcher.tsx` builds `scopedHref` with no section)                                                         |
| Jump anywhere by name                 | n/a                            | `packages/ui/src/components/command.tsx` (cmdk) exists and is unused                                                                                      |

The root layout (`__root.tsx`) adds a third layer of chrome (a `max-w-6xl` top bar with a second
Sign out) around whichever shell renders inside it, so every screen is a card inside a card.

## Decisions

1. **One shell.** A single persistent left sidebar wraps every authenticated screen: Org screens and
   App screens alike. The Org shell and the App shell are deleted, not hidden.
2. **The App is the spine of the sidebar and sits top-left.** App name (with the App switcher) and
   its Environment pills are the first thing on the page. Sections follow in order of use:
   Flags, Experiments, Overview, Segments, Metrics, Settings. Overview is demoted from first to
   third; it stays a destination and remains the landing for a bare `/{org}/{app}/{env}`.
3. **The Organization block is at the bottom of the sidebar**: Apps, Members, Billing & Usage, the
   Organization switcher (multi-org only), the command palette trigger, and the user row with Sign
   out. Rare things are furthest from where the eye starts.
4. **A bare App route exists: `/{org}/{app}` is the App home.** It renders Flags across every
   Environment of that App (one column per Environment, inline enable switches, one promote action
   per row when Environments differ). No Environment is in the URL because a Flag definition is
   App-level. This retires "the App name is a label, not a link" (`app-list-card.tsx`).
5. **No Organization-wide Flags list.** A Flag belongs to one App (`flags_app_key_unique (app_id,
key)`, `packages/db/src/schema/flags.ts:41`); keys can collide across Apps, so a merged list would
   mislead. "All Environments within one App" is the only valid aggregate, and it is the App home.
6. **Environment is a visible control, not a dropdown.** Pills in the sidebar; a segmented control
   next to the page title on Flags/Experiments pages (All environments | dev | prod). The prod
   pill carries the warning token and a ring when active; the page header takes a warning tint and
   a "Production: Policy confirms changes" badge. Switching Environment preserves the path
   (`environmentSwitchHref`, unchanged).
7. **Eye path hierarchy.** Top-left is what you need to know, right is what you might do, bottom
   and far right are rare. Page header: title and Environment control on the left; primary action
   on the right; rarer actions past a divider further right. Tables: identifying column first,
   scanned columns next, reference data and actions last. Home: Continue card first, Apps table
   left (navigation), Needs-you right (attention).
8. **`/{org}` is the home.** Continue-where-you-left-off card (never an automatic redirect), the
   Apps table (App name links to the App home, Environment pills link to that Environment's
   Overview), and a Needs-you column aggregated across the Org's Apps.
9. **Single-Organization users skip the `/` chooser.** `/` redirects to `/{org}` when the session
   holds exactly one Organization. Zero or many still render the chooser. This narrows the
   "chooser, not a redirect" rule in `organization-chooser.tsx` to the cases where there is a
   choice.
10. **Command palette (cmdk).** Jump to any App, Environment, Flag, or Experiment in the current
    Organization; run the common actions (New Flag, section shortcuts). Every palette action is
    the same Control Plane operation the CLI and MCP call, surfaced as a shortcut, never a fourth
    write path.
11. **Create a Flag is two clicks from Home**: App name, New Flag. The created definition lands as
    a new row on the App home with a disabled Switch in every Environment cell (the Control Plane
    initializes a disabled Flag Configuration per Environment at creation), so the first time prod
    is touched is a deliberate click on a cell labeled prod. The
    CLI equivalent (`splitch flags config set <key> --env dev --enabled`) is shown inline for
    parity.
12. **Promote is reachable from the source.** The App home matrix carries a per-row "Promote
    dev → prod" that opens the existing Promotion screen on the target with `?from=` set.
13. **Every write on the new surfaces goes through the existing gated path** (`useFlagEditing`,
    `GatedWriteOutcome`, `updateControlPanelFlagConfig`). No optimistic updates, no second write
    path, prod Policy still confirms.

Unchanged invariants: scope lives in the URL (`navigation-and-ia.md`); `(appId, environmentId)`
resolve at the loader; the Worker is the guardian; hydration gates interactive SSR controls
(`useHydrated`, `data-hydrated`); no emojis in UI; light-dark follows OS.

## The new IA

```text
/                               chooser (0 or 2+ Orgs) or redirect to /{org} (exactly 1)
/{org}                          Home: Continue, Apps table, Needs-you
/{org}/members                  Members (same shell)
/{org}/billing                  Billing & Usage (same shell)
/{org}/{app}                    App home: Flags across all Environments      [new]
/{org}/{app}/{env}              Overview (unchanged landing for a bare env)
/{org}/{app}/{env}/flags        Flags in one Environment (segmented control links up to the App home)
/{org}/{app}/{env}/flags/{key}  Flag detail (unchanged)
/{org}/{app}/{env}/flags/{key}/promote?from=  Promotion (unchanged)
/{org}/{app}/{env}/experiments, /segments, /metrics, /settings  unchanged
```

Route precedence: `/{org}/members`, `/{org}/billing`, `/{org}/claim` are static and outrank
`/{org}/{app}` in TanStack's ranking, so an App whose slug is `members`, `billing`, or `claim` is
unreachable at its App home. That collision already exists one level down for `/{org}/{app}/{env}`
versus the static App-level routes; reserve those slugs at App creation (follow-up, see below).

### The sidebar (`PanelSidebar`)

Top to bottom:

1. **App block**: the split signature, the `APP` label, the App name. Clicking the name opens the
   App switcher (Apps of the current Org only; choosing one keeps your section when the target has
   it, otherwise lands on that App's home). Under it, one Environment pill per Environment of the
   App; the active one is filled (primary, or warning for prod); `All` marks the App home.
   On Org screens (Home, Members, Billing) the App block shows the last-visited App of this Org
   when one is known, otherwise "Choose an App" with the switcher.
2. **Sections**: Flags, Experiments, Overview, Segments (App), Metrics (App), Settings. Hrefs are
   `scopedHref(scope, section)` for the active Environment; when no Environment is active (App
   home, Org screens) Flags links to the App home and the other sections link to the last-visited
   or first non-prod Environment of the App. Never prod by default.
3. **Organization block** (bottom, above the palette): `ORGANIZATION` label + name + switcher
   (multi-org only), then Apps (`/{org}`), Members, Billing & Usage.
4. **Palette trigger** ("Search or jump to" with ⌘K) and the **user row** (user id, Sign out as a
   POST form, never a link).

`appSectionRegistry` (`app-shell-navigation.ts`) keeps owning the section list and its
`deferred` guard; only its order changes. `visibleAppSections` stays the single source the
sidebar renders from so `shell-navigation.spec.ts` keeps proving every destination.

### Page header (`PanelPageHeader`)

Left: optional crumb (`ORGANIZATION` on Org screens), the title, the Environment segmented control
where the page has one (Flags, Experiments), and the Environment badge when the active Environment
is guarded (its Policy confirms writes; prod by default). Right: primary action, a divider, rarer
actions. Height 14 (3.5rem); a guarded Environment tints the header with `bg-warning-muted/40`.
The guard tint and badge land with the first Environment-scoped header (slice 3b); slice 1 ships
the header without them so it carries no dead branch.

### Home `/{org}`

- **Continue where you left off**: the last scope this user visited in this Org (`app / env ·
section · n minutes ago`) with a Resume button. Rendered only when known. Source: the httpOnly
  `__last_visited` cookie, bounded to the eight most recently visited Organizations and bound to
  the signed-in user (cleared on sign-out; another user's cookie reads as absent). The
  Environment layout and App home loaders write its per-Organization path and timestamp; Home
  re-checks the entry against the session's Apps and Environments before linking to it. It is
  a hint for a card, never a redirect, so it does not violate the no-hidden-scope rule: the URL
  still names the scope you are in.
- **Apps table** (left, 3/5): App (link to App home), Environments (pills linking to the
  Environment Overview), Flags (count only), Attention (the existing
  `appAttentionSeverity`/`appAttentionSummary` rollup as a badge). Create App top-right of the
  table. The running Experiments count needs a per-Environment read per App and moves to Phase 2
  with the other Needs-you additions. Replaces the card grid (`org-app-list-page.tsx`,
  `app-list-card.tsx`).
- **Needs you** (right, 2/5): one entry per attention item across the Org's Apps, worst first.
  v1 renders what `OrgAppListView.apps[].attention` already carries (SRM firing, Guardrail
  breached, health unknown/unavailable) with an Open link into the Environment's Overview.
  Decision-ready, promotion drift, and pending Approval Requests need a new Org-wide read each
  and are follow-ups (listed below), not silently omitted: the panel header says "Experiment health
  across Apps" so the scope of the column is stated.

### App home `/{org}/{app}`

- Loader: `loadAppScopedSession` resolves Org + App membership and the App's Environments (the same
  `resolveScopedLoaderContext` machinery without the `env` requirement; extract the shared part).
  Then `loadControlPanelFlagsMatrix({ appId, environments })` reads the catalog once and each
  Environment's Configuration via the per-Environment `authorizedFlagsClient` (the delegation is
  Environment-pinned, so one client per column). The result is one view model: per Flag, per
  Environment `{ enabled, rolloutPercentages, controllingExperiment? } | null`, plus per-row drift
  between the promotion source and target.
- Header: title "Flags", segmented control with "All environments" active and one entry per
  Environment (linking to `/{org}/{app}/{env}/flags`), primary New Flag, then Import/Export
  are NOT shipped (nothing to import/export yet; leave the slot empty rather than render dead
  controls).
- Matrix: Flag key (link to the detail page in the first non-prod Environment; the cell's own
  link goes to that Environment's detail), one cell per Environment (Switch + rollout summary +
  Experiment badge, or "Not configured" + Configure link to that Environment's detail page), and a
  last column "{source} → {target}" with a drift badge (Rollout differs / Enabled differs / Availability differs /
  Missing in {target} / In sync) and the Promote link. Source and target follow
  `promotionSources`: target is the last Environment, source the first that is not the target. Apps
  with one Environment render no last column. Apps with three or more Environments show drift
  against the last Environment only (staging → prod), stated in the column header.
- Switch writes use `useFlagEditing` per cell with that cell's `environmentId`; each cell renders
  its own `GatedWriteOutcome` because each cell is a distinct Environment-pinned write path.
- Create Flag reuses `CreateFlagDialog`. `createControlPanelFlag` takes an `environmentId` only to
  mint the delegation; pass the first non-guarded Environment, or the first Environment when all
  are guarded. On success the dialog closes, the
  loader is invalidated, the new row is highlighted (`?created=<key>`) and a success notice says
  the Flag is disabled in every Environment until switched on, with the CLI line inline. The
  empty-state dialog routes through the same created-row state.
- Environments list in creation order everywhere (sidebar pills, segmented control, matrix columns,
  promotion pair): `listEnvironments` orders by `createdAt, key` at the repo seam. The promotion
  target is therefore the newest Environment; an App that adds an Environment after prod gets that
  Environment as the target until a per-App promotion target exists (Phase 2).
- `loadControlPanelFlagsMatrix` refuses Environment ids outside the App before reading, because an
  App with zero Flags sends no per-column read that would otherwise catch a foreign column.
- Empty state: the existing `FlagsEmptyState` teaching copy, New Flag primary.
- `readTruncated` is carried and rendered with `FlagsTruncatedNotice`, as today.

### Flags in one Environment `/{org}/{app}/{env}/flags`

Same header with the segmented control (that Environment active, "All environments" links up to
the App home). Rows gain the inline enable Switch (same write path) and lose the Badge. Master-detail
(list left, detail right, URL names the selected Flag) is Phase 2.

### Command palette

`packages/ui/src/components/command.tsx` in a `CommandDialog`, mounted once in the shell, opened
by ⌘K / Ctrl+K and the sidebar trigger. Groups: Jump to (Apps and Environments of the current Org
from the shell's navigation data; Flags and Experiments of the current App fetched on open via a
server fn), Actions (New Flag in the current App, Go to Flags/Experiments/Overview/Settings for the
active scope, Members, Billing). Results navigate with the router; no writes happen inside the
palette other than opening the existing Create Flag dialog.
The index is fetched when the palette opens and cleared when it closes, and New Flag opens the
existing `CreateFlagDialog` in controlled mode.

## Slices

Dependency order. Each slice is its own PR, its own worktree, its own review gate
(`ziw-code-review` or `code-reviewer` + visual check in a browser on the local stack), and is
merged before the next starts unless marked parallel.

### Slice 1: One shell, new hierarchy

- New `PanelSidebar`, `PanelPageHeader`, `PanelShell` (sidebar + main, full-bleed). `__root.tsx`
  drops its own header and `max-w-6xl` wrapper for authenticated routes; `/` chooser,
  `/claim/consent/*`, and `kitchen-sink` keep a minimal frame.
- `$orgSlug.index.tsx`, `$orgSlug.members.tsx`, `$orgSlug.billing.tsx` render inside
  `PanelShell` with the Org block active. Their loaders already fetch the session; extend with the
  App/Environment navigation the sidebar needs (`resolveScopedLoaderContext`'s navigation half,
  extracted into `resolveNavigation(session, resolver)` so both scopes share it).
- `$orgSlug.$appSlug.$env.tsx` renders `PanelShell` with the App block active; `AppShell`,
  `AppShellSwitchers`, `OrgShell`, `ShellMenu` are deleted. The App switcher keeps the section:
  target href is `scopedHref(targetScope, currentSection)` when the target App has an Environment
  with the same `env`, else that App's home.
- `appSectionRegistry` reordered: Flags, Experiments, Overview, Segments, Metrics, Settings.
- Sign out lives in the sidebar user row only (POST form).
- Tests: `app-shell-navigation.test.ts` order; `shell-navigation.spec.ts` (header assertions move
  to the sidebar: the `form[action='/auth/logout']` and no-kitchen-sink checks), `org-shell.spec.ts`
  and `shell.spec.ts` selectors (`data-org-shell`, `data-app-shell`, `data-hydrated` stay, on the
  new shell root).
- Done: every route renders in one shell; from a Flag detail page Members is one click; the
  sidebar order matches decision 2; `pnpm verify:ci --force` green; screenshots of Home, Flags
  (dev), Flags (prod), Members attached to the PR.

- Follow-up (found in review, not blocking): `resolveNavigation` resolves Environments for every
  App in every Organization of the session, one D1 query per App, and only the current App's
  Environments are rendered. Slice 2 moves the App switcher to App-home hrefs, after which
  navigation needs Environments for the current App only; scope the resolver then.

### Slice 2: App home (Flags across all Environments)

- [x] `loadAppScopedSession` + `resolveAppLoaderContext` (no env), route `$orgSlug.$appSlug.index.tsx`
      with `notFound`/`AccessDenied` handling mirroring `$orgSlug.$appSlug.$env.tsx`.
- [x] `loadControlPanelFlagsMatrix` server fn + `flags-matrix-data.ts` view model + unit tests
      (drift classification, source/target selection, `readTruncated` carry).
- [x] `FlagsMatrixPage`, `FlagsMatrixTable`, `FlagsMatrixRow`, `FlagsMatrixCell` components (each under
      300 lines). Segmented Environment control component shared with slice 3b.
- [x] App name links on Home (slice 1 table) and the sidebar App block link here.
- [x] Create Flag from here with the created-row state.
- Done:
  - [x] Home → App name → New Flag → created row is two clicks and one dialog.
  - [x] Toggling a prod cell raises the Policy gate and the confirmed write re-reads.
  - [x] Promote opens the Promotion screen with `?from=`.
  - [x] `flags.spec.ts` includes the matrix flow.
  - [ ] Screenshots attached to the PR.

### Slice 3a: Home (parallel with 3b)

- [x] `__last_visited` cookie written by the Environment layout and App home loaders (path, section,
      timestamp, per Organization, bounded to eight Organizations); read by the Home loader; Continue
      card.
- [x] Apps table replaces the card grid; Needs-you column from the existing attention rollup; Create
      App top-right of the table.
- [x] `/` redirects to `/{org}` for an exact one-Organization session only when no resync is pending
      and the session Organization list is complete (`routes/index.tsx` loader).
- [x] Tests: Home component and loader unit coverage; e2e `org-shell.spec.ts`, `shell.spec.ts`, and
      `create-organization.spec.ts` updated for Home and the redirect. A fresh user has zero
      Organizations and still sees the chooser/sign-up surface.
- Done:
  - [x] A single-Organization user lands on Home.
  - [x] Continue appears after visiting an App.
  - [x] Every App name and Environment pill is a link.
  - [ ] Screenshots attached to the PR.

### Slice 3b: Flags in one Environment gets the segmented control and inline switches (parallel with 3a)

- [x] `PanelPageBody` is the one inset paired with `PanelPageHeader`; env-scoped leaf routes own it
      after the env layout renders its Outlet bare. `SectionPending` and `SectionUnavailable` keep
      pending and error states on the same inset.
- [x] `FlagsPage` uses `PanelPageHeader` with the segmented control. Its `environment` prop adds the
      guarded Environment badge and warning tint, while the shared matrix passes no Environment.
- [x] `FlagsTableRow` renders the Switch through `useFlagEditing`. The outcome renders per row because
      the write controller is per Flag, preserving one `GatedWriteOutcome` per write controller.
- Done:
  - [x] Flipping a dev Flag from the list applies and re-reads.
  - [x] Flipping in prod raises the gate.
  - [x] `flag-editing.spec.ts` covers both list-level Policy paths.

### Slice 4: Command palette

- [x] `CommandDialog` mounted in `PanelShell`; ⌘K; groups as specified; `loadControlPanelPaletteIndex`
      server fn returning Flag keys and Experiment names for the current App.
- Done:
  - [x] ⌘K from any screen.
  - [x] Typing a Flag key and pressing Enter lands on its detail in the active Environment.
  - [x] "New Flag" opens the dialog.
  - [x] Keyboard-only operation proven in `e2e/control-panel/command-palette.spec.ts`.

### Phase 2 (not started, in priority order)

- Flags master-detail on the Environment page (Direction D).
- Experiments list: inline Start / End / Conclude / Results on rows; Environment segmented control;
  "All environments" view for Experiments.
- Needs-you additions: decision-ready Runs, promotion drift, pending Approval Requests (each needs a
  new Org-wide read in the Control Plane and the SDK; each is a parity operation, so CLI and MCP
  get it too).
- Reserve `members`, `billing`, `claim` as App slugs and `flags`, `experiments`, `segments`,
  `metrics`, `settings` as Environment keys at creation time.
- `g f` / `g e` keyboard shortcuts.

## Amendments to existing specs (done per slice)

- `navigation-and-ia.md`: "The three switchers" becomes sidebar controls; "Sidebar: scoped to the
  active App + Environment" gains the App home and the Org block; the App list bullet no longer
  says the App name is a label.
- `screen-inventory.md`: "Two shells" becomes "One shell"; "App list" becomes "Home"; a new "App
  home" section before "App landing: the Overview"; Flags gains the matrix and inline switches.
- `organization-chooser.tsx` and `app-list-card.tsx` doc comments are deleted with the files or
  rewritten to match decisions 4 and 9.

## Out of scope

- Web Analytics section (still not shipped; the registry keeps it out).
- Any change to Control Plane routes, the SDK, CLI, or MCP. Everything here is panel-only and uses
  existing operations. The Phase 2 Needs-you items are the first that would not be.
- Mobile layout beyond the sidebar collapsing to a top strip under `md`.
