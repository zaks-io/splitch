import type { Repository } from "@splitch/db";

const DELETE_BATCH_SIZE = 1_000;

export async function deleteAppPrivacyExports(bucket: R2Bucket, appId: string): Promise<number> {
  const prefix = `privacy-exports/${appId}/`;
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await bucket.list({
      prefix,
      limit: DELETE_BATCH_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
    if (page.truncated && !cursor) throw new Error("R2 privacy export listing omitted its cursor");
  } while (cursor);
  return deleted;
}

export async function deleteOrphanedPrivacyExports(
  bucket: R2Bucket,
  repo: Repository,
): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await bucket.list({
      prefix: "privacy-exports/",
      limit: DELETE_BATCH_SIZE,
      include: ["customMetadata"],
      ...(cursor ? { cursor } : {}),
    });
    const orphanKeys = await findOrphanKeys(page.objects, repo);
    if (orphanKeys.length > 0) {
      await bucket.delete(orphanKeys);
      deleted += orphanKeys.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
    if (page.truncated && !cursor) throw new Error("R2 privacy export listing omitted its cursor");
  } while (cursor);
  return deleted;
}

async function findOrphanKeys(objects: R2Object[], repo: Repository): Promise<string[]> {
  const keys: string[] = [];
  for (const object of objects) {
    const requestId = object.customMetadata?.requestId;
    const job = requestId ? await repo.privacy.getPrivacyJobByRequestId(requestId) : null;
    if (job?.artifactKey !== object.key) keys.push(object.key);
  }
  return keys;
}
