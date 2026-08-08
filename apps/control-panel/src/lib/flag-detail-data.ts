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
 * No Flag with this key exists in this App.
 *
 * Absence is proven by the Control Plane's keyed `flags_get` (id or key), not by
 * scanning a bounded catalog page — so a miss is a true miss, including when the
 * App's catalog is larger than `FLAG_LIST_READ_LIMIT`.
 */
export type FlagDetailNotFound = { code: "FLAG_NOT_FOUND" };

/**
 * Resolve a Flag by its URL `key` and read its Configuration for one Environment.
 *
 * The key is the addressable identity (immutable after create). `flags_get`
 * accepts that key directly, so the definition read does not depend on whether
 * the Flag still fits inside the bounded catalog list page.
 *
 * A missing Configuration is a real state, not an error: a Flag created through
 * the guided flow has a definition in every Environment before anyone narrows its
 * availability here. `FLAG_NOT_FOUND` from the Configuration read means exactly
 * that and is reported as `configuration: null`; any other failure propagates.
 */
export async function readFlagDetail(
  flags: Pick<FlagsClient, "get" | "getConfig">,
  scope: { appId: string; environmentId: string },
  flagKey: string,
): Promise<ControlPlaneOperationResult<FlagDetailData | FlagDetailNotFound>> {
  const fetched = await flags.get({ appId: scope.appId, flagId: flagKey });
  if (!fetched.ok) {
    if (fetched.error.code === "FLAG_NOT_FOUND") {
      return { ok: true, status: 200, data: { code: "FLAG_NOT_FOUND" } };
    }
    return fetched;
  }

  const definition = fetched.data;
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
