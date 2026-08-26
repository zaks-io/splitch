import type { ConvexConfigSnapshot } from "@splitch/contracts";
import {
  configSnapshotProvider,
  parseConfigSnapshot,
  type Provider,
} from "@splitch/evaluation-core";

export function parseSnapshot(payload: string): ConvexConfigSnapshot {
  return parseConfigSnapshot(payload, "Convex");
}

export function snapshotProvider(snapshot: ConvexConfigSnapshot): Provider {
  return configSnapshotProvider(snapshot, "Convex");
}
