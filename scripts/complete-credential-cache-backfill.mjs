const maxBatches = 10_000;

export async function completeCredentialCacheBackfill({ origin, token, fetchImpl = fetch }) {
  if (!origin)
    throw new Error("usage: complete-credential-cache-backfill.mjs <control-plane-origin>");
  if (!token) throw new Error("SPLITCH_DEPLOY_GATE_TOKEN is required");

  const gate = new URL("/internal/credential-cache-backfill", origin);
  async function request(path, init) {
    const endpoint = new URL(gate);
    endpoint.pathname = `${gate.pathname}${path}`;
    const response = await fetchImpl(endpoint, {
      ...init,
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok)
      throw new Error(`credential cache backfill gate returned HTTP ${response.status}`);
    const body = await response.json();
    if (!body || !["client", "api", "done"].includes(body.kind)) {
      throw new Error("credential cache backfill gate returned an invalid checkpoint");
    }
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
