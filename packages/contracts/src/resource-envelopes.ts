// This is the bounded resource-envelope public surface, kept separate from the package entry point.
// The Flag-level JSON Schema validator rides with the flag envelopes: the panel
// and the Worker validate CreateFlagRequest.schema through this one module.
// biome-ignore lint/performance/noBarrelFile: bounded resource-envelope public surface
export {
  schemaDefinitionIssues,
  type ValidationIssue,
  validateJsonSchema,
} from "./flag-definition-schema";
// biome-ignore lint/performance/noReExportAll: write-bound vocabulary is consumed with the envelopes
export * from "./persisted-field-limits";
// biome-ignore lint/performance/noReExportAll: each source module owns a cohesive resource family
export * from "./resource-envelopes-account";
// biome-ignore lint/performance/noReExportAll: each source module owns a cohesive resource family
export * from "./resource-envelopes-experiment";
// biome-ignore lint/performance/noReExportAll: each source module owns a cohesive resource family
export * from "./resource-envelopes-flag";
// biome-ignore lint/performance/noReExportAll: each source module owns a cohesive resource family
export * from "./resource-envelopes-usage";
// biome-ignore lint/performance/noReExportAll: write-only persisted schemas are consumed with the envelopes
export * from "./write-persisted-schemas";
