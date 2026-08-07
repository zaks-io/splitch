const maxBatches = 10_000;
const requiredCheckpointVersion = 2;

export async function completeCredentialCacheBackfill({ origin, token, fetchImpl = fetch }) {
  if (!origin)
    throw new Error("usage: complete-credential-cache-backfill.mjs <control-plane-origin>");
  if (!token) throw new Error("SPLITCH_DEPLOY_GATE_TOKEN is required");

  const gate = new URL("/internal/credential-cache-backfill", origin);
  /**
   * The deploy installs marker-aware Evaluation first, then the compatible
   * Control Plane writer that serves this gate. Requiring the current checkpoint
   * version prevents an older `done` state from skipping the marker backfill.
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
        `credential cache backfill gate at ${gate.origin} is unreachable (${cause instanceof Error ? cause.name : "unknown error"}); the compatible Control Plane did not become reachable`,
      );
    }
    if (!response.ok) {
      const bootstrap =
        response.status === 404
          ? "; the compatible Control Plane did not expose the migration gate"
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
