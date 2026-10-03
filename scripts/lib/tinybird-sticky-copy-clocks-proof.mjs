import { output, run } from "./tinybird-process.mjs";

/**
 * Fixture state for app_ttl_activation: snapshot has day-1 first_ingest_ts /
 * first_exposure_ts and a sticky activation_ingest_ts; raw retains only a
 * non-qualifying day-10 repeat. A COPY_MODE replace must keep min(previous, raw)
 * clocks and first-exposure membership so the Entity (and Activation) survive.
 */
export async function proveStickyCopyClocksAfterExpiry(cwd, shiftMs, fail) {
  const before = await queryDedupedTtlEntity(cwd, fail);
  const earlyIngestMs = shiftMs(Date.parse("2026-07-01T00:00:00Z"));
  const earlyExposureMs = shiftMs(Date.parse("2026-07-01T00:00:00Z"));
  const activationIngestMs = shiftMs(Date.parse("2026-07-05T00:00:00Z"));
  if (
    before?.first_ingest_ts_ms !== earlyIngestMs ||
    before?.first_exposure_ts_ms !== earlyExposureMs ||
    before?.activation_ingest_ts_ms !== activationIngestMs
  ) {
    fail("deduped_exposures TTL fixture must start with sticky day-1 clocks before Copy replace");
  }

  await run(
    "tb",
    [
      "--no-version-warning",
      "copy",
      "run",
      "cp_deduped_exposures",
      "--wait",
      "--mode",
      "replace",
      "--param",
      "copy_watermark_ts=2026-07-12 00:00:00.000",
    ],
    cwd,
  );

  const after = await queryDedupedTtlEntity(cwd, fail);
  if (
    after?.first_ingest_ts_ms !== earlyIngestMs ||
    after?.first_exposure_ts_ms !== earlyExposureMs ||
    after?.activation_ingest_ts_ms !== activationIngestMs
  ) {
    fail(
      `Copy replace after raw TTL must keep sticky clocks; got first_ingest_ts_ms=${after?.first_ingest_ts_ms}, first_exposure_ts_ms=${after?.first_exposure_ts_ms}, activation_ingest_ts_ms=${after?.activation_ingest_ts_ms}`,
    );
  }
  console.log(
    "✓ cp_deduped_exposures: Copy replace after raw TTL keeps sticky first_ingest_ts / first_exposure_ts / activation_ingest_ts",
  );
}

async function queryDedupedTtlEntity(cwd, fail) {
  const raw = await output(
    "tb",
    [
      "--no-version-warning",
      "--output",
      "json",
      "sql",
      `SELECT
        targeting_key_hash,
        toUnixTimestamp64Milli(first_ingest_ts) AS first_ingest_ts_ms,
        toUnixTimestamp64Milli(first_exposure_ts) AS first_exposure_ts_ms,
        toUnixTimestamp64Milli(activation_ingest_ts) AS activation_ingest_ts_ms
      FROM deduped_exposures
      WHERE app_id = 'app_ttl_activation'
        AND run_id = 'run_ttl'
        AND targeting_key_hash = 'tk_ttl_repeat'
      LIMIT 1`,
    ],
    cwd,
  );
  try {
    return JSON.parse(raw).data?.[0] ?? null;
  } catch {
    fail("deduped_exposures TTL sticky-clock query returned invalid JSON");
  }
}
