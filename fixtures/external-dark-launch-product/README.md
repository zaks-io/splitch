# External dark-launch product fixture

Minimal product surface used by SPL-168 to prove a clean external install of the
packed `@splitch/sdk` tarball and a targeted dark launch against shared preview.

This directory is **outside** the pnpm workspace graph. Install only from a packed
tarball — never link monorepo packages.

```bash
# From the splitch repository root:
pnpm --filter @splitch/sdk build
PACK_DIR="$(mktemp -d)"
TARBALL="$(node packages/sdk/scripts/pack-release.mjs "$PACK_DIR" | tail -1)"

# Copy this fixture to a temp consumer and install the tarball:
CONSUMER="$(mktemp -d)"
cp -R fixtures/external-dark-launch-product/. "$CONSUMER/"
npm install --prefix "$CONSUMER" "$PACK_DIR/$TARBALL"

SPLITCH_CLIENT_KEY=ck_... \
SPLITCH_ENDPOINT=https://edge.preview.splitch.dev \
  node "$CONSUMER/resolve.mjs" verify \
    --flag dark-launch-demo \
    --targeting-key user-cohort-a \
    --attribute cohort=launch
```

Synthetic Targeting Keys only. Never commit credentials.
