import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
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
export type KinNumbersListResult = typeof KinNumbersListResult.Type;

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
export type KinNumbersValuesResult = typeof KinNumbersValuesResult.Type;
export const KinNumbersRecordResult = Schema.Struct({ recorded: NonNegativeInt });
export const KinNumbersListInput = Schema.Struct({ orgId: KinOrgId });
export type KinNumbersListInput = typeof KinNumbersListInput.Type;
export const KinNumbersValuesInput = Schema.Struct({
  orgId: KinOrgId,
  number: KinRecordKey,
  from: KinDay,
  to: KinDay,
});
export type KinNumbersValuesInput = typeof KinNumbersValuesInput.Type;
export const KinNumbersRecordInput = Schema.Struct({
  orgId: KinOrgId,
  ...KinNumberValueInput.fields,
  clientRequestId: KinWorkCreateInput.fields.clientRequestId,
});
/** A watched number as the owner level sets it up, archived ones included, for its form. */
export const KinNumberDefinition = Schema.Struct({
  key: KinRecordKey,
  rev: NonNegativeInt,
  name: Schema.String,
  unit: Schema.optional(Schema.String),
  direction: Schema.optional(KinNumberDirection),
  every: Schema.optional(KinNumberCadence),
  above: Schema.optional(KinNumberDecimal),
  below: Schema.optional(KinNumberDecimal),
  source: Schema.optional(KinNumberSource),
  /** Kin computes it from its records: read-only, never shared with members. */
  computed: Schema.Boolean,
  shared: Schema.Boolean,
  archived: Schema.Boolean,
});
export type KinNumberDefinition = typeof KinNumberDefinition.Type;
export const KinNumbersDefinitionsInput = Schema.Struct({ orgId: KinOrgId });
export type KinNumbersDefinitionsInput = typeof KinNumbersDefinitionsInput.Type;
export const KinNumbersDefinitionsResult = Schema.Struct({
  numbers: Schema.Array(KinNumberDefinition),
});
export type KinNumbersDefinitionsResult = typeof KinNumbersDefinitionsResult.Type;
/** Watches a number, or with `key` and `rev` changes, archives or restores one; `null` clears. */
export const KinNumberSaveInput = Schema.Struct({
  orgId: KinOrgId,
  key: Schema.optional(KinRecordKey),
  rev: Schema.optional(NonNegativeInt),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  unit: Schema.optional(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(40)))),
  direction: Schema.optional(Schema.NullOr(KinNumberDirection)),
  every: Schema.optional(Schema.NullOr(KinNumberCadence)),
  above: Schema.optional(Schema.NullOr(KinNumberDecimal)),
  below: Schema.optional(Schema.NullOr(KinNumberDecimal)),
  source: Schema.optional(Schema.NullOr(KinNumberSource)),
  shared: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
  clientRequestId: KinWorkCreateInput.fields.clientRequestId,
});
export type KinNumberSaveInput = typeof KinNumberSaveInput.Type;
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
  Rpc.make("kin.numbers.definitions", {
    payload: KinNumbersDefinitionsInput,
    success: KinNumbersDefinitionsResult,
    error,
  }),
  Rpc.make("kin.numbers.save", {
    payload: KinNumberSaveInput,
    success: KinNumberDefinition,
    error,
  }),
] as const;
export const KIN_NUMBERS_RPC_SCOPES = {
  "kin.numbers.list": AuthKinChatScope,
  "kin.numbers.values": AuthKinChatScope,
  "kin.numbers.record": AuthKinChatScope,
  "kin.numbers.definitions": AuthKinChatScope,
  "kin.numbers.save": AuthKinChatScope,
} as const;
