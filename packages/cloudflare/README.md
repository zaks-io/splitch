# @splitch/cloudflare

Deploy Splitch evaluation into a customer-owned Cloudflare Worker backed by a SQLite Durable Object.
Configuration is pushed from Splitch, and application Workers evaluate both Flags and live
Experiments locally through a service binding.

```bash
npm install @splitch/cloudflare @splitch/cli wrangler
npx splitch cloudflare setup --env production
```

The setup command requires `SPLITCH_API_KEY`, Wrangler 4, an authenticated Cloudflare account, and
an application `wrangler.jsonc`. It creates the integration
Worker and adds the `SPLITCH` service binding. Application Workers then call
`env.SPLITCH.evaluate(...)` or `env.SPLITCH.evaluateDetails(...)`.

Setup runs the application's own Wrangler under the current Node binary when there is one, and
otherwise the `wrangler` on `PATH`. It never shells out to a package-manager `exec` shim, so npm,
pnpm, yarn, bun, and a global install all work the same.

See [splitch.dev](https://splitch.dev) for the complete setup and runtime contract.
