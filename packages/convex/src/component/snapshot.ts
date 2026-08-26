import {
  configSnapshotProvider,
  type ConvexConfigSnapshot,
  parseConfigSnapshot,
  type Provider,
} from "@splitch/sdk/local-evaluation";

export function parseSnapshot(payload: string): ConvexConfigSnapshot {
  return parseConfigSnapshot(payload, "Convex");
}

export function snapshotProvider(snapshot: ConvexConfigSnapshot): Provider {
  return configSnapshotProvider(snapshot, "Convex");
}
