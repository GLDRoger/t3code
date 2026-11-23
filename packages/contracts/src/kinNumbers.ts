import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt } from "./baseSchemas.ts";
import { KinAgentId, KinChatError, KinOrgId, KinPersonId, KinTrimmedText } from "./kinChat.ts";
import { KinDay, KinMoneyTotals } from "./kinMoney.ts";
import { KinRecordKey, KinWorkCreateInput } from "./kinWork.ts";

export const KinNumberDecimal = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^-?[0-9]+(?:\.[0-9]+)?$/),
);
export const KinNumberSource = KinTrimmedText.check(
  Schema.isMaxLength(240),
  Schema.isPattern(/^[^\r\n]+$/),
);
export const KinNumberDirection = Schema.Literals(["up", "down"]);
export const KinNumberCadence = Schema.Literals(["day", "week", "month"]);

export const KinNumber = Schema.Struct({
  key: KinRecordKey,
  name: Schema.String,
  unit: Schema.optional(Schema.String),
  value: Schema.NullOr(Schema.Union([KinNumberDecimal, KinMoneyTotals])),
  asOf: Schema.NullOr(KinDay),
  direction: Schema.optional(KinNumberDirection),
  above: Schema.optional(KinNumberDecimal),
  below: Schema.optional(KinNumberDecimal),
  off: Schema.Boolean,
  stale: Schema.Boolean,
  source: Schema.optional(KinNumberSource),
  canType: Schema.Boolean,
});
export type KinNumber = typeof KinNumber.Type;
export const KinNumbersListResult = Schema.Struct({ numbers: Schema.Array(KinNumber) });

export const KinNumberValueInput = Schema.Struct({
  number: KinRecordKey,
  value: KinNumberDecimal,
  asOf: KinDay,
  source: Schema.optional(KinNumberSource),
});
export type KinNumberValueInput = typeof KinNumberValueInput.Type;
export const KinNumberValue = KinNumberValueInput.mapFields(({ number: _, ...fields }) => ({
  ...fields,
  by: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("person"), id: KinPersonId, name: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("agent"), id: KinAgentId, name: Schema.String }),
  ]),
}));
export const KinNumbersValuesResult = Schema.Struct({
  number: KinRecordKey,
  values: Schema.Array(KinNumberValue),
});
export const KinNumbersRecordResult = Schema.Struct({ recorded: NonNegativeInt });
export const KinNumbersListInput = Schema.Struct({ orgId: KinOrgId });
export const KinNumbersValuesInput = Schema.Struct({
  orgId: KinOrgId,
  number: KinRecordKey,
  from: KinDay,
  to: KinDay,
});
export const KinNumbersRecordInput = Schema.Struct({
  orgId: KinOrgId,
  ...KinNumberValueInput.fields,
  clientRequestId: KinWorkCreateInput.fields.clientRequestId,
});
const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);

export const KinNumbersRpcs = [
  Rpc.make("kin.numbers.list", {
    payload: KinNumbersListInput,
    success: KinNumbersListResult,
    error,
  }),
  Rpc.make("kin.numbers.values", {
    payload: KinNumbersValuesInput,
    success: KinNumbersValuesResult,
    error,
  }),
  Rpc.make("kin.numbers.record", {
    payload: KinNumbersRecordInput,
    success: KinNumbersRecordResult,
    error,
  }),
] as const;
export const KIN_NUMBERS_RPC_SCOPES = {
  "kin.numbers.list": AuthKinChatScope,
  "kin.numbers.values": AuthKinChatScope,
  "kin.numbers.record": AuthKinChatScope,
} as const;
