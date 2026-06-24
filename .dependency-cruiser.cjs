module.exports = {
  forbidden: [
    {
      name: "no-app-to-other-app-imports",
      severity: "error",
      comment:
        "Deployable apps are capability and trust boundaries. Share code through packages; communicate through runtime bindings or clients.",
      from: { path: "^apps/([^/]+)/" },
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
      name: "public-sdk-does-not-import-internal-surfaces",
      severity: "error",
      comment:
        "@splitch/sdk is the public data-plane package. It must not import app code, control-plane transport, private contracts, or UI.",
      from: { path: "^packages/sdk/" },
      to: { path: "^(apps|packages/(contracts|control-plane-sdk|ui))/" },
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
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
