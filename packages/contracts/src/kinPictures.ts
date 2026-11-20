import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinChatError, KinOrgId } from "./kinChat.ts";
import { KinConnectionKey } from "./kinConnections.ts";
import { KinDay } from "./kinMoney.ts";

/**
 * Generated pictures: one image service behind an owner-level key, and a monthly count. Not a
 * connection preset, so an older phone's Connections list decodes as before.
 */

/** What Settings offers when a key is first saved. */
export const KIN_PICTURES_PROPOSED_LIMIT = 50;
/** A monthly picture count; null is No limit. */
export const KinPicturesLimit = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
);
export type KinPicturesLimit = typeof KinPicturesLimit.Type;

export const KinPicturesInput = Schema.Struct({ orgId: KinOrgId });
export type KinPicturesInput = typeof KinPicturesInput.Type;

export const KinPicturesView = Schema.Struct({
  orgId: KinOrgId,
  vendor: Schema.Struct({
    label: TrimmedNonEmptyString,
    /** Where an owner makes a key. */
    keyUrl: Schema.String,
  }),
  connected: Schema.Boolean,
  /** When the key in use was saved; null with no key. */
  savedAt: Schema.NullOr(IsoDateTime),
  model: TrimmedNonEmptyString,
  monthlyLimit: KinPicturesLimit,
  /** Counted in the company's time zone, and kept with No limit too. */
  usedThisMonth: NonNegativeInt,
  /** The first day of next month, in the company's time zone. */
  resetsOn: KinDay,
});
export type KinPicturesView = typeof KinPicturesView.Type;

/** Each field left out is left as it is; a first key with no limit given takes the proposed one. */
export const KinPicturesSetInput = Schema.Struct({
  orgId: KinOrgId,
  key: Schema.optional(KinConnectionKey),
  monthlyLimit: Schema.optional(KinPicturesLimit),
  model: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(80), Schema.isPattern(/^[A-Za-z0-9._-]+$/)),
  ),
  /** Forgets the key; the limit and this month's count stay. */
  disconnect: Schema.optional(Schema.Literal(true)),
});
export type KinPicturesSetInput = typeof KinPicturesSetInput.Type;

const KinError = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
export const KinPicturesRpcs = [
  Rpc.make("kin.pictures.get", {
    payload: KinPicturesInput,
    success: KinPicturesView,
    error: KinError,
  }),
  Rpc.make("kin.pictures.set", {
    payload: KinPicturesSetInput,
    success: KinPicturesView,
    error: KinError,
  }),
] as const;

export const KIN_PICTURES_RPC_SCOPES = {
  "kin.pictures.get": AuthKinChatScope,
  "kin.pictures.set": AuthKinChatScope,
} as const;
