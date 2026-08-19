import type { ExperimentConfigKV, FlagConfigKV, RunConfigKV } from "@splitch/contracts";
import {
  ExperimentConfigKVSchema,
  FlagConfigKVSchema,
  kvEnvelope,
  RunConfigKVSchema,
} from "@splitch/contracts";
import { ProviderError } from "./provider";

export type BlobParse<T> = (json: unknown) => { ok: true; value: T } | { ok: false; error: string };

type SafeParse<T> =
  | { success: true; data: { data: T } }
  | { success: false; error: { message: string } };

function blobParser<T>(envelope: { safeParse: (json: unknown) => SafeParse<T> }): BlobParse<T> {
  return (json) => {
    const parsed = envelope.safeParse(json);
    return parsed.success
      ? { ok: true, value: parsed.data.data }
      : { ok: false, error: parsed.error.message };
  };
}

export const parseFlagConfig = blobParser<FlagConfigKV>(kvEnvelope(FlagConfigKVSchema));
export const parseExperimentConfig = blobParser<ExperimentConfigKV>(
  kvEnvelope(ExperimentConfigKVSchema),
);
export const parseRunConfig = blobParser<RunConfigKV>(kvEnvelope(RunConfigKVSchema));

export async function readKvBlob<T>(
  kv: { get(key: string): Promise<string | null> },
  key: string,
  parse: BlobParse<T>,
  label: string,
  missCode: ProviderError["errorCode"] = "INTERNAL_SERVER_ERROR",
): Promise<T> {
  const raw = await kv.get(key);
  if (raw === null) {
    throw new ProviderError(`KV miss for ${label} (key "${key}")`, { errorCode: missCode });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new ProviderError(`Malformed JSON for ${label} (key "${key}")`, { cause });
  }

  const parsed = parse(json);
  if (!parsed.ok) {
    throw new ProviderError(`Invalid KV blob for ${label} (key "${key}"): ${parsed.error}`);
  }
  return parsed.value;
}
