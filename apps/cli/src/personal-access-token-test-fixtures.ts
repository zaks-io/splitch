import { join } from "node:path";
import type { PersonalAccessToken } from "@splitch/sdk/control-plane";
import { expect, vi } from "vitest";
import { executeInvocation } from "./execute.js";
import { parseInvocation } from "./parse-args.js";
import {
  deviceAuthorizationResponse,
  type FakeResponse,
  storedCredential,
} from "./test-fixtures.js";
import { makeTempHome } from "./test-helpers.js";

function jwt(claims: Record<string, unknown>): string {
  return `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
}

export const STEP_UP = jwt({
  sub: "user_test",
  authorization: "pat-management",
  scopes: [],
  jti: "approval",
});
export const CATALOG_READ = jwt({ scopes: [], authorization: "membership-wide-read" });
export const SECRET = `spl_pat_${"a".repeat(64)}`;
const FINITE = "2099-01-01T00:00:00.000Z";
export const TOKEN: PersonalAccessToken = {
  id: `pat_${"1".repeat(32)}`,
  name: "sandboxes",
  grants: [{ target: "app:app_1", role: "member", permissions: [] }],
  expiresAt: FINITE,
  neverExpires: false,
  status: "active",
  fingerprint: "abcdef012345",
  createdAt: "2026-10-03T00:00:00.000Z",
  lastRotatedAt: null,
  revokedAt: null,
};
export const BROAD: PersonalAccessToken = {
  ...TOKEN,
  grants: [{ target: "all", role: "owner", permissions: ["write", "delete"] }],
  expiresAt: null,
  neverExpires: true,
};

interface RunOptions {
  current?: PersonalAccessToken;
  scopes?: string[];
  authorization?: string;
  mutation?: (request: Request) => Response | Promise<Response>;
  approvalFailure?: boolean;
  pending?: boolean;
  tokenMode?: boolean;
  catalogReadRebind?: boolean;
  catalogFailure?: boolean;
  catalogTruncated?: boolean;
}

type CapturedRequest = Pick<Request, "url" | "method" | "headers" | "text">;

function approvalResponses(options: RunOptions): (path: string) => Response {
  let polls = 0;
  return (path) => {
    if (path === "/oauth2/device_authorization")
      return Response.json(deviceAuthorizationResponse());
    if (options.pending && polls++ === 0) {
      return Response.json({ error: "authorization_pending" }, { status: 400 });
    }
    if (options.approvalFailure) {
      return Response.json(
        { error: "access_denied", error_description: `${STEP_UP} ${SECRET}` },
        { status: 400 },
      );
    }
    return Response.json({ access_token: STEP_UP, expires_in: 300 });
  };
}

function operationResponse(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (request.method === "PATCH" || path.endsWith("/revoke")) return Response.json(TOKEN);
  if (path.endsWith("/revoke-all")) return Response.json({ revokedCount: 1 });
  return Response.json({ token: TOKEN, secret: SECRET });
}

function catalogResponse(options: RunOptions): Response {
  if (options.catalogFailure) {
    return Response.json(
      { code: "INTERNAL_SERVER_ERROR", message: "App catalog unavailable", details: {} },
      { status: 503 },
    );
  }
  return Response.json({
    items: options.catalogTruncated
      ? Array.from({ length: 200 }, (_, index) => ({
          id: `app_page_${index}`,
          organizationId: "org_1",
          name: `App ${index}`,
          key: `app-${index}`,
          createdAt: TOKEN.createdAt,
          updatedAt: TOKEN.createdAt,
        }))
      : [
          {
            id: "app_1",
            organizationId: "org_1",
            name: "Example",
            key: "example",
            createdAt: TOKEN.createdAt,
            updatedAt: TOKEN.createdAt,
          },
        ],
    readLimit: 200,
    readTruncated: options.catalogTruncated ?? false,
    cursor: null,
  });
}

function appResponse(options: RunOptions, path: string): Response {
  if (options.catalogFailure) return catalogResponse(options);
  return Response.json({
    id: path.split("/").at(-1),
    organizationId: "org_1",
    name: "Example",
    key: "example",
    createdAt: TOKEN.createdAt,
    updatedAt: TOKEN.createdAt,
  });
}

function tokenListResponse(current: PersonalAccessToken = TOKEN): Response {
  return Response.json({
    items: [current],
    readLimit: 200,
    readTruncated: false,
    cursor: null,
  });
}

async function oauthResponse(
  request: Request,
  approve: (path: string) => Response,
): Promise<Response> {
  const body = new URLSearchParams(await request.text());
  if (body.get("grant_type") !== "refresh_token") return approve(new URL(request.url).pathname);
  expect(body.get("authorization")).toBe("membership-wide-read");
  return Response.json({
    access_token: CATALOG_READ,
    refresh_token: "next-refresh-token",
    expires_in: 3600,
    email: "user_test@splitch.test",
  });
}

export async function runPersonalAccessTokenStepUp(args: string[], options: RunOptions = {}) {
  const { dir } = await makeTempHome();
  const outputFile = join(dir, "pat.env");
  const session = storedCredential();
  session.credential.accessToken = jwt({
    scopes: options.scopes ?? ["app:app_1:owner"],
    ...(options.authorization ? { authorization: options.authorization } : {}),
  });
  const credentialStore = {
    load: vi.fn(async () => session),
    save: vi.fn(),
    clear: vi.fn(),
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const consoleLog = vi
    .spyOn(console, "log")
    .mockImplementation((line) => stdout.push(String(line)));
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation((line) => stderr.push(String(line)));
  const requests: CapturedRequest[] = [];
  const approvalResponse = approvalResponses(options);
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const path = new URL(request.url).pathname;
    if (path.startsWith("/oauth2/")) return oauthResponse(request, approvalResponse);
    if (path.endsWith("/apps")) return catalogResponse(options);
    if (/\/apps\/[^/]+$/.test(path)) return appResponse(options, path);
    if (request.method === "GET") return tokenListResponse(options.current);
    return options.mutation ? options.mutation(request) : operationResponse(request);
  };
  const flags =
    args.includes("create") || args.includes("rotate") ? ["--output-file", outputFile] : [];
  const result = await executeInvocation(parseInvocation(["tokens", ...args, ...flags, "--json"]), {
    cwd: dir,
    env: options.tokenMode ? { SPLITCH_TOKEN: SECRET } : {},
    credentialStore,
    fetch: fetchImpl,
    io: { log: (line) => stdout.push(line), error: (line) => stderr.push(line) },
    sleep: async () => {},
  });
  const output = [...stdout, ...stderr].join("\n");
  expect(output).not.toContain(STEP_UP);
  expect(output).not.toContain(SECRET);
  expect(output).not.toContain(session.credential.accessToken);
  expect(output).not.toContain(CATALOG_READ);
  expect(JSON.stringify(credentialStore.save.mock.calls)).not.toContain(STEP_UP);
  if (options.catalogReadRebind) expect(credentialStore.save).toHaveBeenCalledOnce();
  else expect(credentialStore.save).not.toHaveBeenCalled();
  expect(credentialStore.clear).not.toHaveBeenCalled();
  if (options.tokenMode) expect(credentialStore.load).not.toHaveBeenCalled();
  consoleLog.mockRestore();
  consoleError.mockRestore();
  return { result, outputFile, requests, session, output };
}

export function personalAccessTokenMutations(requests: CapturedRequest[]): CapturedRequest[] {
  return requests.filter(
    (request) => !request.url.includes("/oauth2/") && request.method !== "GET",
  );
}

export function personalAccessTokenApprovalResponses(token: unknown): FakeResponse[] {
  return [
    {
      match: (request) =>
        request.method === "GET" && request.url.endsWith("/personal-access-tokens"),
      status: 200,
      body: { items: [token], readLimit: 200, readTruncated: false, cursor: null },
    },
    {
      match: (request) => request.url.endsWith("/oauth2/device_authorization"),
      status: 200,
      body: deviceAuthorizationResponse(),
    },
    {
      match: (request) => request.url.endsWith("/oauth2/token"),
      status: 200,
      body: { access_token: STEP_UP },
    },
  ];
}
