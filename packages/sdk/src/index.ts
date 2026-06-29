// biome-ignore lint/performance/noBarrelFile: package public-API entry (exports "." → index.js); the SDK surface is intentionally aggregated here
export { createFetchTransport, createSplitchClient } from "./client.js";
export type { SplitchClient, SplitchClientOptions } from "./client.js";
export type { EvaluateContext, Logger } from "./evaluate.js";
export { errorCodeForStatus, synthesizeDetails } from "./resolution.js";
export { DEFAULT_REVALIDATE_MS, DEFAULT_SEEN_SET_MAX_SIZE, SeenSet } from "./seen-set.js";
export type { SeenEntry } from "./seen-set.js";
export type { AttributeValue, Transport, TransportRequest, TransportResult } from "./transport.js";
