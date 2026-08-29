import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository } from "../index";
import { appScope } from "./scope";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";

const NOW = "2026-08-28T00:00:00.000Z";
const USER = "user_selector_primary";
const OTHER_USER = "user_selector_other";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
});

afterEach(async () => {
  await local.dispose();
});

describe("identity selector reads", () => {
  it("requires both User membership predicates for same-key App candidates", async () => {
    await seedSelectorGraph(local.d1);

    await expect(repo.identity.findAppSelectorCandidatesForUser(USER, "neuron")).resolves.toEqual([
      { orgSlug: "alpha", appId: "app_alpha", appSlug: "neuron" },
    ]);
  });

  it("excludes an Org member who is not an App member", async () => {
    await seedHalfMembershipCandidate(local.d1, "org");

    await expect(repo.identity.findAppSelectorCandidatesForUser(USER, "neuron")).resolves.toEqual(
      [],
    );
  });

  it("excludes an App member who is not an Org member", async () => {
    await seedHalfMembershipCandidate(local.d1, "app");

    await expect(repo.identity.findAppSelectorCandidatesForUser(USER, "neuron")).resolves.toEqual(
      [],
    );
  });

  it("keeps Environment key reads inside the App scope", async () => {
    await seedSelectorGraph(local.d1);
    const alpha = appScope("app_alpha");

    await expect(repo.identity.getEnvironmentByKey(alpha, "production")).resolves.toMatchObject({
      id: "env_alpha_production",
      appId: "app_alpha",
    });
    await expect(repo.identity.getEnvironmentByKey(alpha, "victim-only")).resolves.toBeNull();
  });

  it("finds candidates for every Environment selector in one query", async () => {
    await seedSelectorGraph(local.d1);
    let prepared = 0;
    const counting = new Proxy(local.d1, {
      get(target, property, receiver) {
        if (property === "prepare") prepared += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    const candidates = await createRepository(
      counting,
    ).identity.findEnvironmentSelectorCandidatesForSelectors(appScope("app_alpha"), [
      "production",
      "env_alpha_production",
      "victim-only",
    ]);

    expect(candidates).toEqual([
      { environmentId: "env_alpha_production", environmentKey: "production" },
    ]);
    expect(prepared).toBe(1);
  });
});

async function seedHalfMembershipCandidate(
  d1: D1Database,
  membership: "org" | "app",
): Promise<void> {
  await d1
    .prepare(
      `INSERT INTO organizations (id, name, slug, plan, is_provisional, created_at, updated_at)
       VALUES ('org_half', 'Half', 'half', 'free', 0, '${NOW}', '${NOW}')`,
    )
    .run();
  await d1
    .prepare(
      `INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by)
       VALUES ('app_half', 'org_half', 'Half App', 'neuron', '${NOW}', '${NOW}', '${OTHER_USER}')`,
    )
    .run();
  await d1
    .prepare(
      `INSERT INTO org_memberships (org_id, user_id, role, created_at)
       VALUES ('org_half', '${membership === "org" ? USER : OTHER_USER}', 'owner', '${NOW}')`,
    )
    .run();
  await d1
    .prepare(
      `INSERT INTO app_memberships (app_id, user_id, role, created_at)
       VALUES ('app_half', '${membership === "app" ? USER : OTHER_USER}', 'owner', '${NOW}')`,
    )
    .run();
}

async function seedSelectorGraph(d1: D1Database): Promise<void> {
  const statements = [
    `INSERT INTO organizations (id, name, slug, plan, is_provisional, created_at, updated_at) VALUES
       ('org_alpha', 'Alpha', 'alpha', 'free', 0, '${NOW}', '${NOW}'),
       ('org_bravo', 'Bravo', 'bravo', 'free', 0, '${NOW}', '${NOW}'),
       ('org_charlie', 'Charlie', 'charlie', 'free', 0, '${NOW}', '${NOW}'),
       ('org_delta', 'Delta', 'delta', 'free', 0, '${NOW}', '${NOW}')`,
    `INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES
       ('app_alpha', 'org_alpha', 'Alpha App', 'neuron', '${NOW}', '${NOW}', '${USER}'),
       ('app_bravo', 'org_bravo', 'Bravo App', 'neuron', '${NOW}', '${NOW}', '${OTHER_USER}'),
       ('app_charlie', 'org_charlie', 'Charlie App', 'neuron', '${NOW}', '${NOW}', '${OTHER_USER}'),
       ('app_delta', 'org_delta', 'Delta App', 'neuron', '${NOW}', '${NOW}', '${OTHER_USER}')`,
    `INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES
       ('org_alpha', '${USER}', 'owner', '${NOW}'),
       ('org_bravo', '${OTHER_USER}', 'owner', '${NOW}'),
       ('org_charlie', '${USER}', 'member', '${NOW}'),
       ('org_charlie', '${OTHER_USER}', 'owner', '${NOW}'),
       ('org_delta', '${OTHER_USER}', 'owner', '${NOW}')`,
    `INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES
       ('app_alpha', '${USER}', 'owner', '${NOW}'),
       ('app_bravo', '${OTHER_USER}', 'owner', '${NOW}'),
       ('app_charlie', '${OTHER_USER}', 'owner', '${NOW}'),
       ('app_delta', '${USER}', 'member', '${NOW}'),
       ('app_delta', '${OTHER_USER}', 'owner', '${NOW}')`,
    `INSERT INTO environments (id, app_id, key, name, created_at, updated_at, created_by) VALUES
       ('env_alpha_production', 'app_alpha', 'production', 'Production', '${NOW}', '${NOW}', '${USER}'),
       ('env_bravo_production', 'app_bravo', 'production', 'Production', '${NOW}', '${NOW}', '${OTHER_USER}'),
       ('env_bravo_victim', 'app_bravo', 'victim-only', 'Victim', '${NOW}', '${NOW}', '${OTHER_USER}')`,
  ];
  for (const statement of statements) await d1.prepare(statement).run();
}
