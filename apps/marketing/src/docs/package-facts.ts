import { engines as sdkEngines } from "../../../../packages/sdk/package.json";

/**
 * Requirements the docs state, read from the manifest npm enforces them with.
 * A requirement typed into prose drifts silently: the install page carried a
 * pinned `@splitch/sdk` version for three minor releases after it stopped being
 * the published one, and nothing failed.
 *
 * This is a JSON import, so the value is inlined at build time and no manifest
 * reaches the browser bundle. The relative path reaches across the workspace on
 * purpose; the package does not export its own `package.json`, and a copy of the
 * number in `apps/marketing` would be the drift this module exists to prevent.
 */
function minimumNodeMajor(engines: { readonly node?: string }, pkg: string): number {
  const major = /^>=\s*(\d+)/.exec(engines.node ?? "")?.[1];
  if (major === undefined)
    throw new Error(
      `${pkg} declares engines.node ${JSON.stringify(engines.node)}; the docs render a ">=<major>" floor and cannot describe this range`,
    );
  return Number(major);
}

/** Node floor for `@splitch/sdk`, from its `engines.node`. */
export const sdkNodeMajor = minimumNodeMajor(sdkEngines, "@splitch/sdk");
