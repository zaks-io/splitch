import { describe, expect, it } from "vitest";
// biome-ignore lint/performance/noNamespaceImport: roots and nested schema names are derived
import * as contractsSurface from "../../contracts/src/sdk-data-plane-surface";
import {
  discoverRefinements,
  isSchema,
  type Refinement,
  refinementRejects,
} from "../scripts/contract-surface-refine-inventory";
// biome-ignore lint/performance/noNamespaceImport: the guard derives compiled counterparts
import * as compiledSurface from "./generated/contract-surface.js";

type ParityFixture = {
  readonly name: string;
  readonly schemaName: string;
  readonly input: unknown;
};

const id = "11111111-1111-4111-8111-111111111111";
const evaluateAllEntry = {
  variant: true,
  variantName: "on",
  reason: "SPLIT",
  errorCode: null,
  exposureIdentity: "identity",
  exposureTicket: "ticket",
};

const parityFixtures: readonly ParityFixture[] = [
  {
    name: "Resolution Details require error fields for ERROR",
    schemaName: "ResolutionDetailsSchema",
    input: { value: false, variantName: null, reason: "ERROR" },
  },
  {
    name: "Resolution Details require ruleId for TARGETING_MATCH",
    schemaName: "ResolutionDetailsSchema",
    input: { value: true, variantName: "on", reason: "TARGETING_MATCH" },
  },
  {
    name: "Evaluate All requires errorCode for ERROR",
    schemaName: "EvaluateAllResponseSchema",
    input: {
      evaluations: {
        flag: {
          ...evaluateAllEntry,
          reason: "ERROR",
          errorCode: null,
          exposureIdentity: null,
          exposureTicket: null,
        },
      },
    },
  },
  {
    name: "Evaluate All limits Exposure fields to SPLIT",
    schemaName: "EvaluateAllResponseSchema",
    input: { evaluations: { flag: { ...evaluateAllEntry, reason: "DEFAULT" } } },
  },
  {
    name: "Evaluate All rejects an unpaired Exposure Identity",
    schemaName: "EvaluateAllResponseSchema",
    input: {
      evaluations: { flag: { ...evaluateAllEntry, reason: "DEFAULT", exposureTicket: null } },
    },
  },
  {
    name: "Evaluate All requires Exposure Identity and Ticket together",
    schemaName: "EvaluateAllResponseSchema",
    input: { evaluations: { flag: { ...evaluateAllEntry, exposureIdentity: null } } },
  },
  {
    name: "Exposure rejection status and code must agree",
    schemaName: "ExposureBatchResponseSchema",
    input: { results: [{ exposureId: id, status: "accepted", code: "VALIDATION_ERROR" }] },
  },
];

function fixtureRejects(refinement: Refinement, fixture: ParityFixture): boolean {
  return refinement.rootName === fixture.schemaName && refinementRejects(refinement, fixture.input);
}

function matchFixtures(refinements: readonly Refinement[]): readonly (number | undefined)[] {
  // A fixture may trip coupled rules, but it owns only one. Otherwise adding a
  // second refine that happens to reject an existing input would not force a decision.
  const ownerByFixture: (number | undefined)[] = parityFixtures.map(() => undefined);
  function claim(refinementIndex: number, seen: Set<number>): boolean {
    for (const [fixtureIndex, fixture] of parityFixtures.entries()) {
      if (seen.has(fixtureIndex) || !fixtureRejects(refinements[refinementIndex], fixture))
        continue;
      seen.add(fixtureIndex);
      const previous = ownerByFixture[fixtureIndex];
      if (previous === undefined || claim(previous, seen)) {
        ownerByFixture[fixtureIndex] = refinementIndex;
        return true;
      }
    }
    return false;
  }
  for (const index of refinements.keys()) claim(index, new Set());
  return ownerByFixture;
}

function label(refinement: Refinement): string {
  const suffix = refinement.message ?? `unnamed refine #${refinement.index + 1}`;
  return `${refinement.schemaName}: ${suffix}`;
}

describe("contract-surface refine parity", () => {
  const contractExports = contractsSurface as Record<string, unknown>;
  const compiledExports = compiledSurface as Record<string, unknown>;
  const { refinements, roots } = discoverRefinements(contractExports, compiledExports);

  it("requires one parity fixture for every live contracts refine", () => {
    const owners = matchFixtures(refinements);
    const covered = new Set(owners.filter((owner): owner is number => owner !== undefined));
    const missing = refinements.filter((_, index) => !covered.has(index)).map(label);
    const unused = parityFixtures
      .filter((_, index) => owners[index] === undefined)
      .map((row) => row.name);

    expect(
      missing,
      `contracts refines without SDK parity fixtures:\n${missing.join("\n")}`,
    ).toEqual([]);
    expect(unused, `fixtures that do not cover a contracts refine:\n${unused.join("\n")}`).toEqual(
      [],
    );
  });

  it.each(parityFixtures)("$name", (fixture) => {
    const contract = roots.get(fixture.schemaName);
    const compiled = compiledExports[fixture.schemaName];
    expect(contract, `${fixture.schemaName} is not a derived contracts root`).toBeDefined();
    expect(isSchema(compiled), `${fixture.schemaName} has no compiled SDK counterpart`).toBe(true);
    if (contract === undefined || !isSchema(compiled)) return;
    expect(contract.safeParse(fixture.input).success, "contracts accepted the parity fixture").toBe(
      false,
    );
    expect(compiled.safeParse(fixture.input).success, "SDK accepted the parity fixture").toBe(
      false,
    );
  });
});
