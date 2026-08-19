# SSR SDK consumer fixture

Framework-neutral local SSR proof for the packed `@splitch/sdk` tarball. The
fixture runs a Node HTTP server, calls `evaluateAll` with an API Key, serializes
the result into HTML, and hydrates it through `@splitch/sdk/browser` with the
matching Evaluation Context.

The test uses a local double for the splitch edge. It asserts that bootstrap
performs no client fetch, the server and hydrated JSON values are byte-identical,
the first read sends exactly one item to `/api/sdk/exposures`, and a mismatched
context throws `SDK_BOOTSTRAP_CONTEXT_MISMATCH`.

```bash
# From the repository root. The fixture packs and installs the built SDK in a
# temporary consumer directory, outside the pnpm workspace.
pnpm --filter @splitch/sdk build
pnpm --dir fixtures/ssr-sdk-consumer test
```

The API Key exists only in the server options. The rendered page contains the
public Client Key, evaluated results, and Exposure bindings. It contains no
Targeting Rules, allocation, or salts.
