# @splitch/sdk

Public JavaScript/TypeScript SDK for splitch data-plane evaluation.

## Install from npm

```bash
npm install @splitch/sdk
```

## Private dogfooding (packed tarball)

Before `@splitch/sdk` is on the public npm registry, install the packed artifact from a
repository checkout. The consumer must be outside this monorepo workspace so installs resolve
only the tarball (no `@splitch/contracts` or other workspace packages).

```bash
# From the splitch repository root:
pnpm --filter @splitch/sdk build
PACK_DIR="$(mktemp -d)"
TARBALL="$(node packages/sdk/scripts/pack-release.mjs "$PACK_DIR" | tail -1)"
npm install "$PACK_DIR/$TARBALL"
```

Replace `npm install` with `pnpm add` or `yarn add` in your product as needed; the path to the
`.tgz` file is the only requirement.

## Hello-world evaluate

Exposure-bearing `evaluate` requires a stable per-logical-evaluation `idempotencyKey`. Reuse the
same key when retrying an uncertain request.

```ts
import { createSplitchClient } from "@splitch/sdk";

const splitch = createSplitchClient({ clientKey: "ck_live_..." });

const evaluationId = crypto.randomUUID();
const variant = await splitch.evaluate("new-checkout", {
  targetingKey: userId,
  idempotencyKey: evaluationId,
});
```

See `docs/spec/quickstart.md` and `docs/spec/sdk/exposure-accessor.md` for the full onboarding
path.
