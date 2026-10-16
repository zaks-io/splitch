import type { PersonalAccessTokenRow, Repository, PersonalAccessTokenStepUpUse } from "@splitch/db";
import { PersonalAccessTokenClaimRefused } from "@splitch/db";
import { sha256Hex } from "./credential-cache";
import { writePersonalAccessTokenCache } from "./personal-access-token-store";

/** Every rotation, including ordinary issuance, takes the exclusive D1 claim first. */
export async function rotatePersonalAccessToken(
  tokens: Repository["personalAccessTokens"],
  store: KVNamespace,
  current: PersonalAccessTokenRow,
  candidateHash: string,
  nowMs: number,
  stepUp?: PersonalAccessTokenStepUpUse,
): Promise<PersonalAccessTokenRow> {
  const id = crypto.randomUUID();
  const now = new Date(nowMs).toISOString();
  const operationHash = await sha256Hex(
    JSON.stringify([
      "rotate",
      current.userId,
      current.id,
      current.tokenHash,
      current.grants,
      current.expiresAt,
      candidateHash,
    ]),
  );
  if (!(await tokens.claimRotation(current, { id, candidateHash, operationHash, now }, stepUp)))
    throw new PersonalAccessTokenClaimRefused();
  const advance = async (
    from: "claimed" | "old_tombstoned" | "swapped",
    to: "old_tombstoned" | "candidate_published" | "completed",
  ) => {
    if (!(await tokens.advanceRotation(current.userId, id, from, to, now)))
      throw new PersonalAccessTokenClaimRefused();
  };
  // Failures deliberately retain the owned claim. Scheduled recovery revokes the
  // row before retiring both hashes; a rejected retry never executes recovery.
  await writePersonalAccessTokenCache(store, current, current.tokenHash, true, nowMs);
  await advance("claimed", "old_tombstoned");
  await writePersonalAccessTokenCache(store, current, candidateHash, false, nowMs);
  await advance("old_tombstoned", "candidate_published");
  const rotated = await tokens.swapRotation(current.userId, id, now);
  if (!rotated) throw new PersonalAccessTokenClaimRefused();
  await advance("swapped", "completed");
  return rotated;
}

export async function runPersonalAccessTokenRetention(
  tokens: Repository["personalAccessTokens"],
  store: KVNamespace,
  nowMs: number,
): Promise<void> {
  const now = new Date(nowMs).toISOString();
  const pending = await tokens.pendingRotations(new Date(nowMs - 300_000).toISOString(), 100);
  for (const claim of pending) {
    await tokens.retireRotation(claim.userId, claim.id, now);
    const row = await tokens.getForUser(claim.userId, claim.tokenId);
    if (!row || row.revokedAt === null) continue;
    await writePersonalAccessTokenCache(store, row, claim.previousHash, true, nowMs);
    await writePersonalAccessTokenCache(store, row, claim.candidateHash, true, nowMs);
    await tokens.advanceRotation(claim.userId, claim.id, "retiring", "retired", now);
  }
  await tokens.purgeStepUpUses(now, 100);
}
