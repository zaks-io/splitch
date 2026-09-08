import type { Repository } from "@splitch/db";
import { describe, expect, it } from "vitest";
import {
  handlePrivacyExportDownload,
  privacyExportDownloadFields,
} from "./privacy-export-download";

const now = new Date("2026-07-18T12:00:00.000Z");
const secret = "test-privacy-export-signing-secret";
const job = {
  requestId: "prv_export_1",
  kind: "export",
  status: "completed",
  artifactKey: "privacy-exports/app_1/prv_export_1.json",
  artifactSha256: `sha256:${"a".repeat(64)}`,
  artifactExpiresAt: "2026-07-19T12:00:00.000Z",
};
const objectBody = JSON.stringify({ private: true });

describe("privacy export download", () => {
  it("mints a 15-minute URL and serves the private object without persisting the URL", async () => {
    const repo = repository(job);
    const fields = await privacyExportDownloadFields({
      repo,
      requestId: job.requestId,
      requestUrl: "https://api.splitch.test/privacy/requests/prv_export_1",
      secret,
      now,
    });
    expect(fields?.expiresAt).toBe("2026-07-18T12:15:00.000Z");
    const stored = JSON.stringify(job);
    expect(stored).not.toContain("downloadUrl");
    expect(stored).not.toContain("signature");

    const response = await handlePrivacyExportDownload({
      repo,
      bucket: bucket(objectBody),
      request: new Request(fields?.downloadUrl ?? "https://invalid.test"),
      requestId: job.requestId,
      secret,
      now,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-length")).toBe(String(objectBody.length));
    expect(response.headers.get("etag")).toBe('"privacy-export-etag"');
    expect(await response.json()).toEqual({ private: true });
  });

  it("rejects tampered and expired URLs", async () => {
    const repo = repository(job);
    const fields = await privacyExportDownloadFields({
      repo,
      requestId: job.requestId,
      requestUrl: "https://api.splitch.test/privacy/requests/prv_export_1",
      secret,
      now,
    });
    const tampered = new URL(fields?.downloadUrl ?? "https://invalid.test");
    tampered.searchParams.set("signature", "0".repeat(64));
    expect(
      (
        await handlePrivacyExportDownload({
          repo,
          bucket: bucket("secret"),
          request: new Request(tampered),
          requestId: job.requestId,
          secret,
          now,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await handlePrivacyExportDownload({
          repo: repository({ ...job, artifactKey: `${job.artifactKey}.replaced` }),
          bucket: bucket("secret"),
          request: new Request(fields?.downloadUrl ?? "https://invalid.test"),
          requestId: job.requestId,
          secret,
          now,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await handlePrivacyExportDownload({
          repo,
          bucket: bucket("secret"),
          request: new Request(fields?.downloadUrl ?? "https://invalid.test"),
          requestId: job.requestId,
          secret,
          now: new Date("2026-07-18T12:16:00.000Z"),
        })
      ).status,
    ).toBe(410);
  });
});

function repository(value: typeof job): Repository {
  return {
    privacy: { getPrivacyJobByRequestId: async () => value },
  } as unknown as Repository;
}

function bucket(body: string): R2Bucket {
  return {
    async get() {
      return {
        body: new Response(body).body,
        size: body.length,
        httpEtag: '"privacy-export-etag"',
        writeHttpMetadata() {},
      } as R2ObjectBody;
    },
  } as R2Bucket;
}
