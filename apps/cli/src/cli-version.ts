import { createRequire } from "node:module";

export function cliVersion(): string {
  // The published package ships dist/*.js beside package.json; the same
  // relative shape holds in the repo. createRequire keeps this a runtime
  // lookup so the bundler cannot inline a stale value.
  const pkg = createRequire(import.meta.url)("../package.json") as { version?: string };
  if (!pkg.version) {
    throw new Error("package.json next to the CLI bundle has no version");
  }
  return pkg.version;
}

/**
 * The API ships ahead of the published CLI, so a flag this binary refuses may be
 * one a newer release added for a field the live API already accepts. Pointing
 * only at --help would strand an agent on the old binary.
 */
export function unrecognizedFlagRemediation(
  flag: string,
  commandPath: string,
  acceptsBodyJson: boolean,
): string {
  const bodyJson = acceptsBodyJson
    ? ". To send a field this version has no typed flag for, pass it in --body-json"
    : "";
  return (
    `Drop ${flag}, or run splitch ${commandPath} --help to list the accepted flags. ` +
    `The installed CLI (${cliVersion()}) may be older than the API: upgrade with ` +
    `npm install --global @splitch/cli@latest${bodyJson}`
  );
}
