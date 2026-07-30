/**
 * The "Connect your code" handoff strings, in one place.
 *
 * These are the literal characters a developer copies out of the panel, so they
 * are the contract surface of the onboarding screen. `renderConnectSnippet` is
 * held to the shipped `@splitch/sdk` type declarations by the snippet compile
 * guard (`apps/control-panel/scripts/connect-snippet-compile.mjs`) — if the SDK
 * signature moves, the guard fails rather than the panel quietly teaching a
 * snippet that no longer compiles.
 *
 * Note the shipped client takes NO `appId`: app and Environment scope come from
 * the credential alone (ADR-0018), and `SplitchClientOptions` has no such field.
 */

const SDK_PACKAGE_NAME = "@splitch/sdk";

/**
 * The install line shown on the Connect card. `pnpm smoke:connect-snippet
 * --registry` checks that this package name resolves on the public registry; it
 * does NOT install from there (the compile guard installs the local tarball), so
 * a published-but-broken tarball is out of its reach.
 */
export const SDK_INSTALL_COMMAND = `npm install ${SDK_PACKAGE_NAME}`;

export interface ConnectSnippetInput {
  /** The Environment's public Client Key, substituted verbatim. */
  readonly clientKey: string;
  /** The Flag Key the developer just created. */
  readonly flagKey: string;
}

/**
 * The Exposure-bearing call. `idempotencyKey` is required by the SDK and is the
 * caller-owned identity of one logical Evaluation, so the snippet has to mint a
 * stable one rather than leave a hole the reader fills in wrongly (ADR-0036).
 */
export function renderConnectSnippet({ clientKey, flagKey }: ConnectSnippetInput): string {
  return [
    `import { createSplitchClient } from "${SDK_PACKAGE_NAME}";`,
    "",
    `const splitch = createSplitchClient({ clientKey: ${JSON.stringify(clientKey)} });`,
    "",
    "// One stable id per logical Evaluation. Reuse it when you retry that call,",
    "// so a retry is not counted as a second Evaluation.",
    "const evaluationId = crypto.randomUUID();",
    "",
    `const value = await splitch.evaluate(${JSON.stringify(flagKey)}, {`,
    "  targetingKey: userId,",
    "  idempotencyKey: evaluationId,",
    "});",
  ].join("\n");
}

/**
 * The server-runtime variant. A trusted server holds a secret API Key instead of
 * the public Client Key; the API Key is shown once at creation and never
 * redisplayed (ADR-0022), so this snippet reads it from the environment rather
 * than embedding a value the panel is not allowed to reproduce.
 */
export function renderServerConnectSnippet({ flagKey }: { readonly flagKey: string }): string {
  return [
    `import { createSplitchClient } from "${SDK_PACKAGE_NAME}";`,
    "",
    "const splitch = createSplitchClient({ apiKey: process.env.SPLITCH_API_KEY });",
    "",
    "const evaluationId = crypto.randomUUID();",
    `const value = await splitch.evaluate(${JSON.stringify(flagKey)}, {`,
    "  targetingKey: userId,",
    "  idempotencyKey: evaluationId,",
    "});",
  ].join("\n");
}
