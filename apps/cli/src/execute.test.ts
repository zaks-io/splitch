import { getRoute } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { findCommand } from "./command-registry.js";
import { parseInvocation } from "./parse-args.js";
import { executeInvocation } from "./execute.js";
import { EXIT_OK } from "./exit-codes.js";
import {
  createAppResponse,
  FakeCliTransport,
  oauthTokenMint,
  storedCredential,
} from "./test-fixtures.js";

describe("executeInvocation", () => {
  it("calls apps_create with POST", async () => {
    const transport = new FakeCliTransport([
      oauthTokenMint(),
      {
        match: (request) => request.url.includes("/orgs/org_1/apps") && request.method === "POST",
        status: 200,
        body: createAppResponse,
      },
    ]);

    const invocation = parseInvocation([
      "apps",
      "create",
      "--json",
      "--org",
      "org_1",
      "--name",
      "New App",
    ]);
    expect(findCommand(invocation.commandPath)?.operationId).toBe("apps_create");
    expect(getRoute("apps_create")?.method).toBe("POST");

    const result = await executeInvocation(invocation, {
      fetch: transport.fetch,
      credentialStore: {
        load: async () => storedCredential(),
        save: async () => {},
        clear: async () => {},
      },
    });

    expect(result.exitCode).toBe(EXIT_OK);
    const appRequest = transport.requests.find((request) =>
      request.url.includes("/orgs/org_1/apps"),
    );
    expect(appRequest).toMatchObject({
      method: "POST",
      body: {
        name: "New App",
        idempotency_key: expect.stringMatching(/^cli_/),
      },
    });
  });

  it("refreshes before an authorized call when the stored principal still has unknown email", async () => {
    let saved = {
      ...storedCredential(),
      principal: { userId: "user_test", email: "unknown" as string | undefined },
    };
    const transport = new FakeCliTransport([
      oauthTokenMint(),
      {
        match: (request) => request.url.includes("/orgs/org_1/apps") && request.method === "POST",
        status: 200,
        body: createAppResponse,
      },
    ]);

    const result = await executeInvocation(
      parseInvocation(["apps", "create", "--json", "--org", "org_1", "--name", "New App"]),
      {
        fetch: transport.fetch,
        credentialStore: {
          load: async () => saved,
          save: async (file) => {
            saved = file;
          },
          clear: async () => {},
        },
      },
    );

    expect(result.exitCode).toBe(EXIT_OK);
    expect(transport.requests[0]?.url).toContain("/oauth2/token");
    expect(saved.principal.email).toBe("user_test@splitch.test");
    expect(JSON.stringify(saved)).not.toContain("unknown");
  });
});
