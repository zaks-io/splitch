import { z } from "zod";
import {
  ExperimentConfigKVSchema,
  FlagConfigKVSchema,
  RunConfigKVSchema,
} from "./storage-schemas-kv";

export const CONFIG_SNAPSHOT_SCHEMA_VERSION = 1;

export const ConfigSnapshotSchema = z
  .object({
    schemaVersion: z.literal(CONFIG_SNAPSHOT_SCHEMA_VERSION),
    environmentVersion: z.number().int().nonnegative(),
    appId: z.string(),
    environmentId: z.string(),
    flags: z.array(FlagConfigKVSchema),
    experiments: z.array(ExperimentConfigKVSchema),
    runs: z.array(RunConfigKVSchema),
  })
  .strict();

export type ConfigSnapshot = z.infer<typeof ConfigSnapshotSchema>;
