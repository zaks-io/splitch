module.exports = {
  forbidden: [
    {
      name: "no-app-to-other-app-imports",
      severity: "error",
      comment:
        "Deployable apps are capability and trust boundaries. Share code through packages; communicate through runtime bindings or clients.",
      from: {
        path: "^apps/([^/]+)/",
        pathNot: [
          "\\.test\\.[cm]?[jt]sx?$",
          "^apps/cli/src/(quickstart-local-harness|dark-launch-(experiment|http|scenario|negative-auth))\\.ts$",
        ],
      },
      to: { path: "^apps/", pathNot: "^apps/$1/" },
    },
    {
      name: "no-shared-package-to-app-imports",
      severity: "error",
      comment: "Shared packages must stay runtime-agnostic.",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "contracts-stays-schema-only",
      severity: "error",
      comment:
        "@splitch/contracts is Zod schemas, inferred types, route definitions, and error shapes only.",
      from: { path: "^packages/contracts/" },
      to: { path: "^packages/(control-plane-sdk|sdk|ui)/" },
    },
    {
      name: "control-plane-sdk-does-not-import-apps",
      severity: "error",
      comment:
        "@splitch/control-plane-sdk wraps transport and error parsing; it cannot import deployed app code.",
      from: { path: "^packages/control-plane-sdk/" },
      to: { path: "^apps/" },
    },
    {
      name: "sdk-client-entries-do-not-import-platform-surfaces",
      severity: "error",
      comment:
        "The @splitch/sdk root, browser, React, and Sentry entries stay data-plane-only; platform implementation packages are bundled only behind their named subpaths.",
      from: {
        path: "^packages/sdk/",
        pathNot: [
          "^packages/sdk/scripts/",
          "^packages/sdk/src/control-plane/",
          "^packages/sdk/src/local-evaluation/",
          "\\.test\\.[cm]?[jt]sx?$",
          "^packages/sdk/src/contract-surface-assignability\\.ts$",
        ],
      },
      to: { path: "^(apps|packages/(contracts|control-plane-sdk|evaluation-core|ui))/" },
    },
    {
      name: "published-cli-and-convex-use-sdk-interface",
      severity: "error",
      comment:
        "Published CLI and Convex code import the public @splitch/sdk interface, never its private implementation packages.",
      from: { path: "^(apps/cli|packages/convex)/src/" },
      to: {
        path: "^(packages/(contracts|control-plane-sdk|evaluation-core)/|@splitch/(contracts|control-plane-sdk|evaluation-core)(/|$))",
      },
    },
    {
      name: "ui-stays-domain-free",
      severity: "error",
      comment:
        "@splitch/ui is design tokens and primitives only. It must not know domain contracts or transport.",
      from: { path: "^packages/ui/" },
      to: { path: "^(apps|packages/(contracts|control-plane-sdk|sdk))/" },
    },
    {
      name: "marketing-does-not-import-control-plane-sdk",
      severity: "error",
      comment:
        "Marketing may import ui and contracts for examples, but not the control-plane transport SDK.",
      from: { path: "^apps/marketing/" },
      to: { path: "^packages/control-plane-sdk/" },
    },
    {
      name: "worker-runtime-does-not-import-apps",
      severity: "error",
      comment:
        "@splitch/worker-runtime is shared request-guard plumbing; it cannot import deploy units. Apps mount the runtime, never the reverse.",
      from: { path: "^packages/worker-runtime/" },
      to: { path: "^apps/" },
    },
    {
      name: "no-raw-d1-client-outside-db-seam",
      severity: "error",
      comment:
        "The raw Drizzle D1 client is the tenant-isolation bypass (ADR-0018): a handle on it can run an app_id-less, cross-App query. Only the single seam module packages/db/src/repo/client.ts may import drizzle-orm/d1; everything else MUST go through createRepository, whose methods are all scope-bound.",
      // Exempt the one legitimate importer (the seam) AND node_modules itself —
      // drizzle-orm's own d1 submodules import each other, and that is not a
      // bypass. Our source tree is the only subject of this rule.
      from: { pathNot: ["^packages/db/src/repo/client\\.ts$", "/node_modules/"] },
      // Match both the bare specifier (reported when the importer does not depend
      // on drizzle-orm, e.g. another package) AND the resolved pnpm path
      // (.../node_modules/drizzle-orm/d1/...), reported when the importer — like
      // packages/db itself — does. Anchoring only the bare form would miss a
      // bypass added INSIDE packages/db outside the seam.
      to: { path: "(^|/)drizzle-orm/d1(/|$)" },
    },
    {
      name: "no-internal-db-seam-imports",
      severity: "error",
      comment:
        "The repo seam's internals (the raw client + scope-bound table builders) are private to packages/db. Outside code must import the public @splitch/db surface (createRepository, appScope, envScope), never reach into packages/db/src/repo/* directly — that is how the no-raw-client guarantee stays structural.",
      from: { pathNot: "^packages/db/src/" },
      to: {
        path: "^packages/db/src/repo/",
        pathNot: "^packages/db/src/repo/test-d1(?:-pool)?\\.ts$",
      },
    },
    {
      name: "worker-runtime-does-not-own-storage",
      severity: "error",
      comment:
        "@splitch/worker-runtime owns the HTTP edge guard only. It must not import D1 schema modules, Tinybird clients, Provider adapters, or the transport SDKs — storage and capability code stay in their owning Workers.",
      from: { path: "^packages/worker-runtime/" },
      to: { path: "^packages/(control-plane-sdk|sdk|ui)/" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    // Compiled build output is an emitted copy of source already cruised; exclude
    // it so a stale/just-built dist/ does not double-report (and so the seam's
    // compiled client.d.ts is not mistaken for a raw-client bypass). Also exclude
    // node_modules: pnpm symlinks workspace packages into each app's
    // node_modules, and the `apps/**` glob would otherwise re-cruise a package's
    // OWN internals under a symlinked path (e.g. apps/auth-api/node_modules/
    // @splitch/db/src/repo/*), which the seam rules — anchored on the real
    // ^packages/db/src/ path — would mis-flag. The real source tree is the only
    // subject; doNotFollow already stops dependency traversal into node_modules.
    exclude: {
      path: "(^|/)(dist|node_modules)/",
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
