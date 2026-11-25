import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { KinTrimmedText, NonNegativeInt } from "./baseSchemas.ts";
import { KinChatError, KinOrgId } from "./kinChat.ts";

const Name = KinTrimmedText.check(Schema.isMaxLength(40));

export const KinShellSection = Schema.Struct({
  id: Schema.String,
  on: Schema.Boolean,
  name: Schema.optional(Name),
  noun: Schema.optional(Name),
  dock: Schema.optional(Schema.Boolean),
});
export type KinShellSection = typeof KinShellSection.Type;

const Sections = Schema.Array(KinShellSection);
const SetSection = Schema.Struct({
  ...KinShellSection.fields,
  name: Schema.optional(Schema.String),
  noun: Schema.optional(Schema.String),
});
export const KinShell = Schema.Struct({
  rev: NonNegativeInt,
  sections: Sections,
});
export type KinShell = typeof KinShell.Type;

/**
 * Starts the `clientMessageId` of the message "Set up for my kind of company…" sends: the host
 * gives that turn the Chief of staff's set-up guidance. Typed words alone never do.
 */
export const KIN_SET_UP_MESSAGE_PREFIX = "set-up:";

export const KinShellRpcs = [
  Rpc.make("kin.shell.set", {
    payload: Schema.Struct({
      orgId: KinOrgId,
      rev: NonNegativeInt,
      shell: Schema.Struct({ sections: Schema.Array(SetSection) }),
    }),
    success: KinShell,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
] as const;

export const KIN_SHELL_RPC_SCOPES = { "kin.shell.set": AuthKinChatScope } as const;
