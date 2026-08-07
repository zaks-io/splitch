const maxBatches = 10_000;
const requiredCheckpointVersion = 2;

export async function completeCredentialCacheBackfill({ origin, token, fetchImpl = fetch }) {
  if (!origin)
    throw new Error("usage: complete-credential-cache-backfill.mjs <control-plane-origin>");
  if (!token) throw new Error("SPLITCH_DEPLOY_GATE_TOKEN is required");

  const gate = new URL("/internal/credential-cache-backfill", origin);
  /**
   * This drains through the Control Plane ALREADY serving traffic, because it has
   * to finish before the schema-v2 Evaluation Worker ships and Evaluation now has
   * to ship before the Control Plane that binds its entrypoint (ADR-0046). Two
   * consequences are load-bearing for whoever runs a deploy:
   *
   * - an environment that has never been deployed has no gate to drain, so the
   *   chain stops here, at step one, before anything is deployed;
   * - a release that changes the gate itself drains through the OLD gate, so it
   *   cannot ship in a single pass.
   *
   * Neither is silently worked around -- a skipped backfill ships an Evaluation
   * Worker onto credentials it cannot read. The error says which case it is.
   */
  async function request(path, init) {
    const endpoint = new URL(gate);
    endpoint.pathname = `${gate.pathname}${path}`;
    let response;
    try {
      response = await fetchImpl(endpoint, {
        ...init,
        headers: { authorization: `Bearer ${token}` },
      });
    } catch (cause) {
      // The request carries the deploy gate token, so only the error class is
      // reported, never a message that could quote the header back.
      throw new Error(
        `credential cache backfill gate at ${gate.origin} is unreachable (${cause instanceof Error ? cause.name : "unknown error"}); a never-deployed environment has no gate to drain and must be bootstrapped before this chain can run`,
      );
    }
    if (!response.ok) {
      const bootstrap =
        response.status === 404
          ? "; a 404 here usually means this environment has no Control Plane deployed yet"
          : "";
      throw new Error(
        `credential cache backfill gate returned HTTP ${response.status}${bootstrap}`,
      );
    }
    const body = await response.json();
    assertCurrentCheckpoint(body);
    return body;
  }

  let checkpoint = await request("/status");
  for (let batch = 0; checkpoint.kind !== "done" && batch < maxBatches; batch += 1) {
    checkpoint = await request("/run", { method: "POST" });
  }
  if (checkpoint.kind !== "done") {
    throw new Error(`credential cache backfill did not complete within ${maxBatches} batches`);
  }
}

function assertCurrentCheckpoint(value) {
  const valid =
    value !== null &&
    typeof value === "object" &&
    value.version === requiredCheckpointVersion &&
    ["client", "api", "done"].includes(value.kind);
  if (!valid) throw new Error("credential cache backfill gate returned an invalid checkpoint");
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  completeCredentialCacheBackfill({
    origin: process.argv[2],
    token: process.env.SPLITCH_DEPLOY_GATE_TOKEN,
  }).then(
    () => console.log("credential cache backfill verified: done"),
    (error) => {
      console.error(`complete-credential-cache-backfill: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
