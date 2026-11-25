import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import {
  AuthSessionId,
  IsoDateTime,
  KinTrimmedText,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { KinChatError, KinOrgId, KinPersonId } from "./kinChat.ts";

/** Where a person's coding agent reaches the tasks they hold, on the host their invite used. */
export const KIN_TASKS_KEY_PATH = "/kin/you/mcp";
/** Live keys one person may hold at once. */
export const KIN_TASKS_KEY_LIMIT = 3;

/** One coding-agent key as its holder and the owner see it; never its secret. */
export const KinTasksKey = Schema.Struct({
  sessionId: AuthSessionId,
  personId: KinPersonId,
  label: KinTrimmedText,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  /** Whether the reader may remove it; absent from an older host. */
  canRevoke: Schema.optional(Schema.Boolean),
});
export type KinTasksKey = typeof KinTasksKey.Type;

/** A person makes a key for themself only; the caller's session decides who that is. */
export const KinTasksKeysIssueInput = Schema.Struct({
  orgId: KinOrgId,
  label: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(60))),
});
export type KinTasksKeysIssueInput = typeof KinTasksKeysIssueInput.Type;
/** The public address a coding agent anywhere reaches this host by, when the host knows one. */
const KinTasksKeyOrigin = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));

/** `secret` is shown this once; the host keeps no copy it could show again. */
export const KinTasksKeysIssueResult = Schema.Struct({
  key: KinTasksKey,
  secret: TrimmedNonEmptyString,
  path: Schema.Literal(KIN_TASKS_KEY_PATH),
  origin: Schema.optional(KinTasksKeyOrigin),
});
export type KinTasksKeysIssueResult = typeof KinTasksKeysIssueResult.Type;

/** The caller's own live keys, or, for the owner level, another person's. */
export const KinTasksKeysListInput = Schema.Struct({
  orgId: KinOrgId,
  personId: Schema.optional(KinPersonId),
});
export type KinTasksKeysListInput = typeof KinTasksKeysListInput.Type;
export const KinTasksKeysListResult = Schema.Struct({
  keys: Schema.Array(KinTasksKey),
  origin: Schema.optional(KinTasksKeyOrigin),
});
export type KinTasksKeysListResult = typeof KinTasksKeysListResult.Type;

export const KinTasksKeysRevokeInput = Schema.Struct({
  orgId: KinOrgId,
  sessionId: AuthSessionId,
});
export type KinTasksKeysRevokeInput = typeof KinTasksKeysRevokeInput.Type;
export const KinTasksKeysRevokeResult = Schema.Struct({ revoked: Schema.Boolean });
export type KinTasksKeysRevokeResult = typeof KinTasksKeysRevokeResult.Type;

const KIN_TASKS_KEY_WS_METHODS = {
  issue: "kin.tasksKeys.issue",
  list: "kin.tasksKeys.list",
  revoke: "kin.tasksKeys.revoke",
} as const;

const KinTasksKeyError = Schema.Union([KinChatError, EnvironmentAuthorizationError]);

export const KinTasksKeyRpcs = [
  Rpc.make(KIN_TASKS_KEY_WS_METHODS.issue, {
    payload: KinTasksKeysIssueInput,
    success: KinTasksKeysIssueResult,
    error: KinTasksKeyError,
  }),
  Rpc.make(KIN_TASKS_KEY_WS_METHODS.list, {
    payload: KinTasksKeysListInput,
    success: KinTasksKeysListResult,
    error: KinTasksKeyError,
  }),
  Rpc.make(KIN_TASKS_KEY_WS_METHODS.revoke, {
    payload: KinTasksKeysRevokeInput,
    success: KinTasksKeysRevokeResult,
    error: KinTasksKeyError,
  }),
] as const;

// Made and managed from a person's own signed-in session, never with the key itself.
export const KIN_TASKS_KEY_RPC_SCOPES = {
  [KIN_TASKS_KEY_WS_METHODS.issue]: AuthKinChatScope,
  [KIN_TASKS_KEY_WS_METHODS.list]: AuthKinChatScope,
  [KIN_TASKS_KEY_WS_METHODS.revoke]: AuthKinChatScope,
} as const;
