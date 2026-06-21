module.exports = {
  forbidden: [
    {
      name: "no-worker-to-other-worker-imports",
      severity: "error",
      comment:
        "Capability Workers are deploy and trust boundaries. Share code through packages, communicate through runtime bindings or clients.",
      from: { path: "^workers/([^/]+)/" },
      to: { path: "^workers/", pathNot: "^workers/$1/" },
    },
    {
      name: "no-app-to-worker-imports",
      severity: "error",
      comment: "Apps call Workers through @splitch/client or public HTTP endpoints, never by importing Worker internals.",
      from: { path: "^apps/" },
      to: { path: "^workers/" },
    },
    {
      name: "no-worker-to-app-imports",
      severity: "error",
      comment: "Workers are runtime services and cannot depend on UI app code.",
      from: { path: "^workers/" },
      to: { path: "^apps/" },
    },
    {
      name: "no-shared-package-to-runtime-imports",
      severity: "error",
      comment: "Shared packages must stay runtime-agnostic.",
      from: { path: "^packages/" },
      to: { path: "^(apps|workers)/" },
    },
    {
      name: "contracts-stays-schema-only",
      severity: "error",
      comment: "@splitch/contracts is Zod schemas, inferred types, route definitions, and error shapes only.",
      from: { path: "^packages/contracts/" },
      to: { path: "^packages/(client|ui)/" },
    },
    {
      name: "client-does-not-import-runtimes",
      severity: "error",
      comment: "@splitch/client wraps transport and error parsing; it cannot import deployed runtime code.",
      from: { path: "^packages/client/" },
      to: { path: "^(apps|workers)/" },
    },
    {
      name: "ui-stays-domain-free",
      severity: "error",
      comment: "@splitch/ui is design tokens and primitives only. It must not know domain contracts or transport.",
      from: { path: "^packages/ui/" },
      to: { path: "^(apps|workers|packages/(contracts|client))/" },
    },
    {
      name: "marketing-does-not-import-client",
      severity: "error",
      comment: "The Marketing Worker may import ui and contracts for examples, but not the control-plane transport client.",
      from: { path: "^apps/marketing/" },
      to: { path: "^packages/client/" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
