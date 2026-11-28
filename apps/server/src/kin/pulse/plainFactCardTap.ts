import {
  KIN_CHOICE_CARD_ACTION,
  KinWidgetId,
  type KinMessage,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isFactCard, plansOf } from "../widgets/cardPlans.ts";

const decodeChoiceTap = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      widgetId: Schema.String,
      actionId: Schema.String,
      revision: Schema.optional(Schema.Unknown),
      value: Schema.optional(Schema.Unknown),
    }),
  ),
);
export const plainFactCardTap = Effect.fn("KinPulse.plainFactCardTap")(function* (
  orgId: KinOrgId,
  message: KinMessage,
) {
  if (message.kind !== "widget_action" || message.author._tag !== "human") return undefined;
  const personId = message.author.personId;
  const tap = Option.getOrUndefined(decodeChoiceTap(message.body));
  if (tap?.actionId !== KIN_CHOICE_CARD_ACTION || typeof tap.value !== "string") return undefined;
  const plans = yield* plansOf(orgId, tap.widgetId);
  if (plans.has(tap.value)) return undefined;
  const plan = [...plans.values()].find(isFactCard);
  if (plan === undefined || plan.personId !== personId) return undefined;
  return {
    widgetId: KinWidgetId.make(tap.widgetId),
    revision: typeof tap.revision === "number" ? tap.revision : undefined,
    optionId: tap.value,
    personId,
    plan,
  };
});
