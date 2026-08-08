import type { Repository, TenantScope } from "@splitch/db";

type PublishInput = Parameters<Repository["eventDefinitions"]["publish"]>[1];
type PublishedVersion = NonNullable<Awaited<ReturnType<Repository["eventDefinitions"]["publish"]>>>;

interface PublicationArgs {
  readonly store: KVNamespace;
  readonly configKey: string;
  readonly config: string;
  readonly repo: Repository;
  readonly scope: TenantScope;
  readonly input: PublishInput;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly appId: string;
  readonly eventDefinitionId: string;
}

export async function commitEventDefinitionPublication(
  args: PublicationArgs,
): Promise<PublishedVersion> {
  const row = await publishState(args);

  try {
    await args.store.put(args.configKey, args.config);
  } catch (cause) {
    publicationFailure("EventDefinitionConfigWriteError", args, cause);
  }

  return row;
}

/**
 * D1 goes first because neither write rolls back and only one order fails safe.
 * A hot config ahead of D1 hands Metric Event ingest an Event Definition Version
 * id that no D1 row backs, so the stamped events reference a Version nothing can
 * resolve. D1 ahead of the config only leaves readers on the previously
 * published Version until the next publish converges them.
 */
async function publishState(args: PublicationArgs): Promise<PublishedVersion> {
  try {
    const row = await args.repo.eventDefinitions.publish(
      args.scope,
      args.input,
      args.updatedAt,
      args.updatedBy,
    );
    if (!row) publicationFailure("EventDefinitionStateWriteError", args);
    return row;
  } catch (cause) {
    if (cause instanceof Error && cause.name === "EventDefinitionStateWriteError") throw cause;
    publicationFailure("EventDefinitionStateWriteError", args, cause);
  }
}

function publicationFailure(
  name: "EventDefinitionConfigWriteError" | "EventDefinitionStateWriteError",
  args: Pick<PublicationArgs, "appId" | "eventDefinitionId">,
  cause?: unknown,
): never {
  console.error(name, {
    appId: args.appId,
    eventDefinitionId: args.eventDefinitionId,
    cause,
  });
  const failure = new Error(name, { cause });
  failure.name = name;
  throw failure;
}
