import { createRepository } from "@splitch/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyIdJag } from "./idjag-verify";
import { makeJtiCache } from "./jti-cache";
import { makePoolBindings } from "./test-bindings-pool";
import {
  type FixtureKeypair,
  type LocalBindings,
  makeFixtureKeypair,
  signIdJag,
} from "./test-fixtures";
import { makeFixtureWorkOs } from "./workos";

/**
 * Legacy trusted_idps rows must fail closed before any JWKS fetch. Kept out of
 * idjag.test.ts so that file stays under the code-line ratchet.
 */

const ORIGIN = "https://auth.splitch.test";
const CLIENT_ID = "splitch-control-plane";
const NOW_MS = 1_780_000_000_000;
const ISSUER = "https://legacy-private.idp.test";

let local: LocalBindings;
let keys: FixtureKeypair;

beforeAll(async () => {
  local = await makePoolBindings();
  keys = await makeFixtureKeypair();
  await local.d1
    .prepare(
      "INSERT INTO trusted_idps (idp_id, org_id, issuer, jwks_uri, client_ids, enabled, created_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      "idp_legacy_private",
      null,
      ISSUER,
      "https://127.0.0.1/jwks",
      JSON.stringify([CLIENT_ID]),
      1,
      "2026-06-29T00:00:00.000Z",
    )
    .run();
});

afterAll(async () => {
  await local.dispose();
});

describe("ID-JAG JWKS URL policy", () => {
  it("fails closed on a legacy private-network JWKS URI before fetch", async () => {
    const fetchJwks = vi.fn();
    const verifyRemoteSignature = vi.fn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const nowSec = Math.floor(NOW_MS / 1000);
    const idJag = await signIdJag(keys.privateKey, {
      iss: ISSUER,
      aud: CLIENT_ID,
      exp: nowSec + 600,
      auth_time: nowSec - 10,
      email: "agent-user@example.com",
      email_verified: true,
      jti: `jti-${Math.random().toString(36).slice(2)}`,
    });

    await expect(
      verifyIdJag(
        {
          repo: createRepository(local.d1),
          jtiCache: makeJtiCache(local.kv),
          workos: makeFixtureWorkOs(),
          fetchJwks,
          authApiOrigin: ORIGIN,
          now: () => NOW_MS,
        },
        idJag,
      ),
    ).rejects.toMatchObject({ code: "invalid_token", status: 401 });
    await expect(
      verifyIdJag(
        {
          repo: createRepository(local.d1),
          jtiCache: makeJtiCache(local.kv),
          workos: makeFixtureWorkOs(),
          verifyRemoteSignature,
          authApiOrigin: ORIGIN,
          now: () => NOW_MS,
        },
        idJag,
      ),
    ).rejects.toMatchObject({ code: "invalid_token", status: 401 });
    expect(fetchJwks).not.toHaveBeenCalled();
    expect(verifyRemoteSignature).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
