import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type { ComponentApi } from "./component/_generated/component";
import type { EvaluationContext, ResolutionDetails, VariantValue } from "./public-types";

export type { ResolutionDetails, VariantValue } from "./public-types";

export interface ConvexEvaluationContext {
  readonly targetingKey: string;
  readonly idType?: string;
  readonly attributes?: EvaluationContext["attributes"];
}

export interface ConvexExposureContext extends ConvexEvaluationContext {
  readonly idempotencyKey: string;
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

function normalizedContext(context: ConvexEvaluationContext): EvaluationContext {
  return {
    targetingKey: context.targetingKey,
    idType: context.idType ?? "user",
    attributes: context.attributes ?? {},
  };
}
