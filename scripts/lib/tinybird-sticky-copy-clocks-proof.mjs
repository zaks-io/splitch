import { output, run } from "./tinybird-process.mjs";

/**
 * Fixture state for app_ttl_activation: snapshot has day-1 first_ingest_ts /
 * first_exposure_ts and a sticky activation_ingest_ts; raw retains only a
 * non-qualifying day-10 repeat. A COPY_MODE replace must keep min(previous, raw)
 * clocks and first-exposure membership so the Entity (and Activation) survive.
 *
 * Also proves Variant quarantine is sticky across TTL: previous control + raw
 * treatment (tk_straddle) and previous __multiple__ + surviving raw treatment
 * (tk_conflict) both remain __multiple__ after replace.
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

  const beforeVariants = await queryVariantEvidence(cwd, fail);
  if (beforeVariants.tk_straddle !== "control") {
    fail(
      `tk_straddle must start as control in the previous snapshot; got ${beforeVariants.tk_straddle}`,
    );
  }
  if (beforeVariants.tk_conflict !== "__multiple__") {
    fail(`tk_conflict must start as __multiple__; got ${beforeVariants.tk_conflict}`);
  }

  // Fixture clocks are shifted by stageTinybirdProject; the Copy watermark must
  // shift with them or surviving raw Variants fall outside the window and
  // previous_only membership would keep the pre-quarantine arm.
  const copyWatermark = formatCopyWatermark(shiftMs(Date.parse("2026-07-12T00:00:00Z")));
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
      `copy_watermark_ts=${copyWatermark}`,
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

  const afterVariants = await queryVariantEvidence(cwd, fail);
  if (afterVariants.tk_straddle !== "__multiple__") {
    fail(
      `Copy replace must quarantine previous/raw Variant disagreement as __multiple__; got ${afterVariants.tk_straddle}`,
    );
  }
  if (afterVariants.tk_conflict !== "__multiple__") {
    fail(
      `Copy replace must keep previous __multiple__ sticky when a single raw Variant survives; got ${afterVariants.tk_conflict}`,
    );
  }

  console.log(
    "✓ cp_deduped_exposures: Copy replace after raw TTL keeps sticky clocks and Variant quarantine",
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

async function queryVariantEvidence(cwd, fail) {
  const raw = await output(
    "tb",
    [
      "--no-version-warning",
      "--output",
      "json",
      "sql",
      `SELECT targeting_key_hash, variant
      FROM deduped_exposures
      WHERE app_id = 'app_1'
        AND run_id = 'run_1'
        AND targeting_key_hash IN ('tk_straddle', 'tk_conflict')`,
    ],
    cwd,
  );
  try {
    const rows = JSON.parse(raw).data ?? [];
    return Object.fromEntries(rows.map((row) => [row.targeting_key_hash, row.variant]));
  } catch {
    fail("deduped_exposures Variant quarantine query returned invalid JSON");
  }
}

function formatCopyWatermark(ms) {
  const iso = new Date(ms).toISOString();
  // Tinybird DateTime64 params use "YYYY-MM-DD HH:mm:ss.SSS".
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`;
}
