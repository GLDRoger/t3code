import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { KinTrimmedText, NonNegativeInt } from "./baseSchemas.ts";
import { KinChatError, KinOrgId } from "./kinChat.ts";
import { KinDay } from "./kinMoney.ts";

const Address = KinTrimmedText.check(Schema.isMaxLength(254));
const Row = Schema.Struct({
  address: Address,
  name: Schema.NullOr(Schema.String),
  state: Schema.Literals(["waiting", "approved", "declined"]),
  seenCount: NonNegativeInt,
  firstSeenAt: Schema.NullOr(NonNegativeInt),
  lastSeenAt: Schema.NullOr(NonNegativeInt),
  decidedAt: Schema.NullOr(NonNegativeInt),
  decidedBy: Schema.NullOr(Schema.String),
  askedInChat: Schema.Boolean,
});
export const KinBillSendersResult = Schema.Struct({ rows: Schema.Array(Row) });
export type KinBillSendersResult = typeof KinBillSendersResult.Type;

const methods = {
  list: "kin.billSenders.list",
  approve: "kin.billSenders.approve",
  decline: "kin.billSenders.decline",
  remove: "kin.billSenders.remove",
  add: "kin.billSenders.add",
  readSince: "kin.billSenders.readSince",
} as const;
const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
const sender = Schema.Struct({ orgId: KinOrgId, address: Address });

export const KinBillSenderRpcs = [
  Rpc.make(methods.list, {
    payload: Schema.Struct({ orgId: KinOrgId }),
    success: KinBillSendersResult,
    error,
  }),
  Rpc.make(methods.approve, { payload: sender, error }),
  Rpc.make(methods.decline, { payload: sender, error }),
  Rpc.make(methods.remove, { payload: sender, error }),
  Rpc.make(methods.add, {
    payload: sender,
    success: Schema.Union([Schema.Void, Schema.Struct({ message: Schema.String })]),
    error,
  }),
  Rpc.make(methods.readSince, {
    payload: Schema.Struct({ orgId: KinOrgId, address: Address, since: KinDay }),
    success: Schema.Struct({
      queued: NonNegativeInt,
      older: Schema.Boolean,
      stopped: Schema.optional(Schema.Literal(true)),
      text: Schema.String.check(Schema.isMaxLength(500)),
    }),
    error,
  }),
] as const;

export const KIN_BILL_SENDER_RPC_SCOPES = {
  [methods.list]: AuthKinChatScope,
  [methods.approve]: AuthKinChatScope,
  [methods.decline]: AuthKinChatScope,
  [methods.remove]: AuthKinChatScope,
  [methods.add]: AuthKinChatScope,
  [methods.readSince]: AuthKinChatScope,
} as const;
