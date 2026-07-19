const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

export function requireFullCommitSha(value, label = "commit SHA") {
  if (!FULL_COMMIT_SHA.test(value ?? "")) {
    throw new Error(`${label} must be a full lowercase commit SHA; found ${value ?? "none"}`);
  }
  return value;
}

export function resolveDeployedCommitSha({ body, expectedPlatformTarget, route }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${route.surface} health returned a non-object response`);
  }
  if (body.ok !== true) throw new Error(`${route.surface} health ok was not true`);
  if (body.service !== route.service) {
    throw new Error(`${route.surface} reported service ${String(body.service)}`);
  }
  if (body.platformTarget !== expectedPlatformTarget) {
    throw new Error(`${route.surface} reported platformTarget ${String(body.platformTarget)}`);
  }
  return requireFullCommitSha(body.deployedCommitSha, `${route.surface} deployed commit SHA`);
}

export function verifyHealthObservation({
  body,
  expectedCommitSha,
  expectedPlatformTarget,
  route,
}) {
  requireFullCommitSha(expectedCommitSha, "expected deployed commit SHA");
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${route.surface} health returned a non-object response`);
  }
  if (body.ok !== true) throw new Error(`${route.surface} health ok was not true`);
  if (body.service !== route.service) {
    throw new Error(`${route.surface} reported service ${String(body.service)}`);
  }
  if (body.platformTarget !== expectedPlatformTarget) {
    throw new Error(`${route.surface} reported platformTarget ${String(body.platformTarget)}`);
  }
  if (body.deployedCommitSha !== expectedCommitSha) {
    throw new Error(
      `${route.surface} reported deployed commit ${String(body.deployedCommitSha)}; expected ${expectedCommitSha}`,
    );
  }
  return { surface: route.surface, service: route.service, url: route.url };
}

export function createFleetEvidence({ expectedCommitSha, expectedPlatformTarget, observations }) {
  requireFullCommitSha(expectedCommitSha, "expected deployed commit SHA");
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new Error("shared-preview smoke produced no health observations");
  }
  return {
    deployedCommitSha: expectedCommitSha,
    platformTarget: expectedPlatformTarget,
    routes: observations.map(({ body, route }) =>
      verifyHealthObservation({
        body,
        expectedCommitSha,
        expectedPlatformTarget,
        route,
      }),
    ),
  };
}
