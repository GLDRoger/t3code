import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthSettingsWriteScope, EnvironmentAuthorizationError } from "./auth.ts";
import { KinChatError, KinOrgId } from "./kinChat.ts";

/**
 * A host a worker's commands may reach through the sandbox's proxy: a lowercase host name, or one
 * `*.` wildcard. No address, port, scheme or `localhost`, which would open this machine's network.
 */
export const KinWorkerHost = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.makeFilter(
    (value: string) =>
      /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value),
    { expected: "a lowercase host name such as registry.npmjs.org or *.example.com" },
  ),
);
export type KinWorkerHost = typeof KinWorkerHost.Type;

export const KinWorkerNetworkInput = Schema.Struct({ orgId: KinOrgId });
export type KinWorkerNetworkInput = typeof KinWorkerNetworkInput.Type;
export const KinWorkerNetworkChange = Schema.Struct({ orgId: KinOrgId, host: KinWorkerHost });
export type KinWorkerNetworkChange = typeof KinWorkerNetworkChange.Type;

export const KinWorkerNetworkEntry = Schema.Struct({
  host: KinWorkerHost,
  /** `default` ships with Kin, `owner` was added in the app, `host` comes from the server's env. */
  source: Schema.Literals(["default", "owner", "host"]),
});
export type KinWorkerNetworkEntry = typeof KinWorkerNetworkEntry.Type;

/** What the last worker start on this host found; `unchecked` until one has started. */
export const KinWorkerSandboxInstall = Schema.Literals([
  "bubblewrap",
  "socat",
  "apparmor_bwrap_profile",
]);
export type KinWorkerSandboxInstall = typeof KinWorkerSandboxInstall.Type;

export const KinWorkerSandboxStatus = Schema.Struct({
  state: Schema.Literals(["shell", "file_only", "unchecked"]),
  reason: Schema.String,
  /** Epoch ms of the check. */
  checkedAt: Schema.NullOr(Schema.Number),
  claudeCodeVersion: Schema.NullOr(Schema.String),
  /** What the owner can install on the host to give workers a shell. */
  install: Schema.Array(KinWorkerSandboxInstall),
  /** Whether a refused command names its host to the worker, so its report can; null if unknown. */
  namesBlockedHosts: Schema.NullOr(Schema.Boolean),
});
export type KinWorkerSandboxStatus = typeof KinWorkerSandboxStatus.Type;

export const KinWorkerNetwork = Schema.Struct({
  orgId: KinOrgId,
  /** What a worker started now may reach. */
  allowed: Schema.Array(KinWorkerNetworkEntry),
  /** Hosts the owner removed from Kin's defaults or the host's extras; allowing one restores it. */
  removed: Schema.Array(KinWorkerHost),
  sandbox: KinWorkerSandboxStatus,
});
export type KinWorkerNetwork = typeof KinWorkerNetwork.Type;

const KinError = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
// Owner only: which hosts a worker's shell can reach, and whether this host can give it one.
export const KinWorkerNetworkRpcs = [
  Rpc.make("kin.workers.network.get", {
    payload: KinWorkerNetworkInput,
    success: KinWorkerNetwork,
    error: KinError,
  }),
  Rpc.make("kin.workers.network.allow", {
    payload: KinWorkerNetworkChange,
    success: KinWorkerNetwork,
    error: KinError,
  }),
  Rpc.make("kin.workers.network.remove", {
    payload: KinWorkerNetworkChange,
    success: KinWorkerNetwork,
    error: KinError,
  }),
] as const;

// Reading names what the sandbox lacks on the host, so it is an owner setting like the writes.
export const KIN_WORKER_NETWORK_RPC_SCOPES = {
  "kin.workers.network.get": AuthSettingsWriteScope,
  "kin.workers.network.allow": AuthSettingsWriteScope,
  "kin.workers.network.remove": AuthSettingsWriteScope,
} as const;
