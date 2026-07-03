// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); the SDK surface is intentionally aggregated here
export { createSplitchClient } from "./client.js";
export type { SplitchClient, SplitchClientOptions } from "./client.js";
export type { EvaluateContext, Logger } from "./evaluate.js";
