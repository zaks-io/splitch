import {
  type ConvexConfigSnapshot,
  configSnapshotProvider,
  type Provider,
  parseConfigSnapshot,
} from "@splitch/sdk/local-evaluation";

export function parseSnapshot(payload: string): ConvexConfigSnapshot {
  return parseConfigSnapshot(payload, "Convex");
}

export function snapshotProvider(snapshot: ConvexConfigSnapshot): Provider {
  return configSnapshotProvider(snapshot, "Convex");
}
