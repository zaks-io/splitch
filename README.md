# splitch

Unified feature flags and A/B experimentation on Cloudflare's edge — agent-first,
built to scale to millions of events.

[![CI](https://github.com/zaks-io/splitch/actions/workflows/ci.yml/badge.svg)](https://github.com/zaks-io/splitch/actions/workflows/ci.yml)
[![CodeQL](https://github.com/zaks-io/splitch/actions/workflows/codeql.yml/badge.svg)](https://github.com/zaks-io/splitch/actions/workflows/codeql.yml)
[![Security](https://github.com/zaks-io/splitch/actions/workflows/security.yml/badge.svg)](https://github.com/zaks-io/splitch/actions/workflows/security.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/zaks-io/splitch/badge)](https://scorecard.dev/viewer/?uri=github.com/zaks-io/splitch)

> Pre-1.0. The architecture and specs are settled; implementation is in progress.

## What it is

Two planes on Cloudflare:

- **Data plane (hot path):** the public SDK calls the Evaluation Worker, which
  resolves a Variant and fires an Exposure. KV serves reads; per-key Durable
  Objects serialize first-touch writes; events append to Tinybird.
- **Control plane:** authoring (Org/App/Flag/Experiment/Run/Metric), auth, and
  the MCP/CLI surfaces — thin skins over one Zod-first typed contract. The stats
  engine reads the raw Tinybird log.

## Documentation

- **[`docs/vision.md`](docs/vision.md)** — the north star: who it's for and what "good" means.
- **[`CONTEXT.md`](CONTEXT.md)** — the project glossary / ubiquitous language. Start here.
- **[`docs/spec/`](docs/spec/)** — the implementation source of truth.
- **[`docs/adr/`](docs/adr/)** — why each decision was made.

## Security

Security is an enforced product contract, not an afterthought. See
**[`docs/spec/platform/security-model.md`](docs/spec/platform/security-model.md)**
for trust boundaries and the threat model, and **[`SECURITY.md`](SECURITY.md)**
to report a vulnerability.

Continuous controls: CodeQL + Semgrep (with repo-local rules), Dependabot +
OSV-Scanner, gitleaks, Trivy, and OpenSSF Scorecard — re-run daily against
`main`, with every GitHub Action pinned to a commit SHA.

## Development

```sh
pnpm install
pnpm verify:push   # full local gate (lint, typecheck, test, build, security)
```

Local gates run via Lefthook on commit and push. See
[`docs/spec/platform/local-quality-gates.md`](docs/spec/platform/local-quality-gates.md).

## License

See [`LICENSE.md`](LICENSE.md) and [`NOTICE.md`](NOTICE.md).
