import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { KinTrimmedText, NonNegativeInt } from "./baseSchemas.ts";
import { KinChatError, KinOrgId } from "./kinChat.ts";

const Address = KinTrimmedText.check(Schema.isMaxLength(254));
const Ending = Schema.String.check(Schema.isPattern(/^\d{4}$/));
const Row = Schema.Struct({
  address: Address,
  bankName: KinTrimmedText,
  state: Schema.Literals(["approved", "declined", "waiting"]),
  accounts: Schema.Array(Ending),
  firstSeenAt: Schema.NullOr(NonNegativeInt),
  decidedAt: Schema.NullOr(NonNegativeInt),
  decidedBy: Schema.NullOr(Schema.String),
  recordedCount: NonNegativeInt,
  heldCount: NonNegativeInt,
  /** Kin's question about this address is open in the owner's chat. Older servers omit it. */
  askedInChat: Schema.optional(Schema.Boolean),
});
export const KinBankSendersResult = Schema.Struct({ rows: Schema.Array(Row) });
export type KinBankSendersResult = typeof KinBankSendersResult.Type;

const methods = {
  list: "kin.bankSenders.list",
  add: "kin.bankSenders.add",
  remove: "kin.bankSenders.remove",
} as const;
const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);

export const KinBankSenderRpcs = [
  Rpc.make(methods.list, {
    payload: Schema.Struct({ orgId: KinOrgId }),
    success: KinBankSendersResult,
    error,
  }),
  Rpc.make(methods.add, {
    payload: Schema.Struct({
      orgId: KinOrgId,
      address: Address,
      bankName: KinTrimmedText.check(Schema.isMaxLength(160)),
      accounts: Schema.NonEmptyArray(Ending).check(Schema.isMaxLength(10_000)),
    }),
    error,
  }),
  Rpc.make(methods.remove, {
    payload: Schema.Struct({ orgId: KinOrgId, address: Address }),
    error,
  }),
] as const;

export const KIN_BANK_SENDER_RPC_SCOPES = {
  [methods.list]: AuthKinChatScope,
  [methods.add]: AuthKinChatScope,
  [methods.remove]: AuthKinChatScope,
} as const;
