import type { Flag } from "@splitch/contracts";
import type {
  ControlPlaneOperationResult,
  FlagConfigGetOutput,
  FlagsClient,
} from "@splitch/control-plane-sdk";

/**
 * The Flag detail screen's two grains, read from the Worker and paired HERE, in
 * the Control Panel Worker, never in the browser: the App-level DEFINITION and
 * THIS Environment's CONFIGURATION (ADR-0028). They stay separate objects because
 * the screen presents them as separate areas — merging them into one flat record
 * would erase exactly the App-level/per-Environment boundary the screen teaches.
 */
export type FlagDetailData = {
  /** App-level, shared across every Environment: key, schema, catalog, default. */
  definition: {
    id: string;
    key: string;
    name: string;
    description?: string;
    schema: Flag["schema"];
    variants: Flag["variants"];
    defaultVariantId: string;
  };
  /** Per-Environment, or null when this Flag has no Configuration here yet. */
  configuration: FlagConfigGetOutput | null;
};

/**
 * No Flag with this key was reachable.
 *
 * `catalogTruncated` is the difference between "no such Flag" and "we did not
 * look at every Flag". The key is resolved against a BOUNDED catalog read, so
 * when that read hit its ceiling an absent key does not prove absence — and a
 * screen that says "Flag not found" on that evidence is asserting something it
 * did not establish (ADR-0036).
 */
export type FlagDetailNotFound = { code: "FLAG_NOT_FOUND"; catalogTruncated: boolean };

/**
 * Resolve a Flag by its URL `key` and read its Configuration for one Environment.
 *
 * The key is the addressable identity (immutable after create), so the list read
 * that resolves key -> id is also the read that supplies the App-level definition
 * — no extra round trip to have both. That list read is BOUNDED, so a key it did
 * not contain is only proof of absence when the read was not truncated; the
 * not-found outcome carries which of the two it is.
 *
 * A missing Configuration is a real state, not an error: a Flag created through
 * the guided flow has a definition in every Environment before anyone narrows its
 * availability here. `FLAG_NOT_FOUND` from the Configuration read means exactly
 * that and is reported as `configuration: null`; any other failure propagates.
 */
export async function readFlagDetail(
  flags: Pick<FlagsClient, "list" | "getConfig">,
  scope: { appId: string; environmentId: string },
  flagKey: string,
): Promise<ControlPlaneOperationResult<FlagDetailData | FlagDetailNotFound>> {
  const listed = await flags.list({ appId: scope.appId });
  if (!listed.ok) return listed;

  const definition = listed.data.items.find((flag) => flag.key === flagKey);
  if (!definition) {
    return {
      ok: true,
      status: 200,
      data: { code: "FLAG_NOT_FOUND", catalogTruncated: listed.data.readTruncated },
    };
  }

  const configuration = await flags.getConfig({ ...scope, flagId: definition.id });
  if (!configuration.ok && configuration.error.code !== "FLAG_NOT_FOUND") {
    return configuration;
  }

  return {
    ok: true,
    status: 200,
    data: {
      definition: {
        id: definition.id,
        key: definition.key,
        name: definition.name,
        ...(definition.description ? { description: definition.description } : {}),
        schema: definition.schema ?? null,
        variants: definition.variants,
        defaultVariantId: definition.defaultVariantId,
      },
      configuration: configuration.ok ? configuration.data : null,
    },
  };
}

/**
 * Narrows the "no such Flag" outcome, which travels in the SUCCESS channel: the
 * read worked and the answer is that no Flag has this key. Generic over the payload
 * because the same outcome is carried alongside both the raw pairing and the
 * derived view.
 */
export function isFlagDetailNotFound<T extends object>(
  data: T | FlagDetailNotFound,
): data is FlagDetailNotFound {
  return "code" in data;
}
