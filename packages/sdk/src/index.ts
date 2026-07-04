// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); the SDK surface is intentionally aggregated here
export { createSplitchClient } from "./client";
export type { SplitchClient, SplitchClientOptions } from "./client";
export type { EvaluateContext, Logger } from "./evaluate";
