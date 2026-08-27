import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type {
  EvaluationContext,
  LocalResolutionDetails as ResolutionDetails,
  VariantValue,
} from "@splitch/sdk/local-evaluation";
import type { TrackRequest } from "@splitch/sdk";
import type { ComponentApi } from "./component/_generated/component";

export type {
  LocalResolutionDetails as ResolutionDetails,
  VariantValue,
} from "@splitch/sdk/local-evaluation";

export interface ConvexEvaluationContext {
  readonly targetingKey: string;
  readonly idType?: string;
  readonly attributes?: EvaluationContext["attributes"];
}

export interface ConvexExposureContext extends ConvexEvaluationContext {
  readonly idempotencyKey: string;
}

export type ConvexMetricEvent = Omit<TrackRequest, "eventName">;

export interface ConvexTrackReceipt {
  readonly eventId: string;
  readonly queued: true;
}

export interface ConvexTrackStatus {
  readonly eventId: string;
  readonly state: "missing" | "queued" | "accepted" | "terminal" | "suppressed";
  readonly error?: string;
}

export class Splitch {
  constructor(private readonly component: ComponentApi) {}

  install<DataModel extends GenericDataModel>(ctx: GenericActionCtx<DataModel>) {
    return ctx.runAction(this.component.integration.install, {});
  }

  sync<DataModel extends GenericDataModel>(ctx: GenericActionCtx<DataModel>) {
    return ctx.runAction(this.component.integration.syncNow, {});
  }

  rotateSecret<DataModel extends GenericDataModel>(ctx: GenericActionCtx<DataModel>) {
    return ctx.runAction(this.component.integration.rotateSecret, {});
  }

  uninstall<DataModel extends GenericDataModel>(ctx: GenericActionCtx<DataModel>) {
    return ctx.runAction(this.component.integration.uninstall, {});
  }

  deleteEntity<DataModel extends GenericDataModel>(
    ctx: GenericMutationCtx<DataModel>,
    context: Pick<ConvexEvaluationContext, "targetingKey" | "idType">,
  ) {
    return ctx.runMutation(this.component.evaluation.deleteEntity, {
      targetingKey: context.targetingKey,
      idType: context.idType ?? "user",
    });
  }

  track<DataModel extends GenericDataModel>(
    ctx: GenericMutationCtx<DataModel>,
    eventName: string,
    event: ConvexMetricEvent,
  ): Promise<ConvexTrackReceipt> {
    return ctx.runMutation(this.component.metric_event.track, { ...event, eventName });
  }

  trackStatus<DataModel extends GenericDataModel>(
    ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
    eventId: string,
  ): Promise<ConvexTrackStatus> {
    return ctx.runQuery(this.component.metric_event.status, { eventId });
  }

  async peekDetails<DataModel extends GenericDataModel>(
    ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
    flagKey: string,
    context: ConvexEvaluationContext,
    defaultValue: VariantValue,
  ): Promise<ResolutionDetails> {
    return ctx.runQuery(this.component.evaluation.peek, {
      flagKey,
      context: normalizedContext(context),
      defaultValue,
    });
  }

  async peekVariant<DataModel extends GenericDataModel>(
    ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
    flagKey: string,
    context: ConvexEvaluationContext,
    defaultValue: VariantValue,
  ): Promise<VariantValue> {
    return (await this.peekDetails(ctx, flagKey, context, defaultValue)).value;
  }

  async evaluateDetails<DataModel extends GenericDataModel>(
    ctx: GenericMutationCtx<DataModel>,
    flagKey: string,
    context: ConvexExposureContext,
    defaultValue: VariantValue,
  ): Promise<ResolutionDetails> {
    return ctx.runMutation(this.component.evaluation.evaluate, {
      flagKey,
      context: normalizedContext(context),
      defaultValue,
      idempotencyKey: context.idempotencyKey,
    });
  }

  async evaluate<DataModel extends GenericDataModel>(
    ctx: GenericMutationCtx<DataModel>,
    flagKey: string,
    context: ConvexExposureContext,
    defaultValue: VariantValue,
  ): Promise<VariantValue> {
    return (await this.evaluateDetails(ctx, flagKey, context, defaultValue)).value;
  }
}

function normalizedContext(context: ConvexEvaluationContext) {
  return {
    targetingKey: context.targetingKey,
    idType: context.idType ?? "user",
    attributes: context.attributes ?? {},
  };
}
