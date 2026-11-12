import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthSettingsWriteScope, EnvironmentAuthorizationError } from "./auth.ts";
import { KinChatError, KinOrgId } from "./kinChat.ts";

const hostName = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// Resolve to this machine, the LAN or the tailnet; the proxy refuses loopback only by address.
const privateSuffixes = ["localhost", "local", "internal", "home.arpa", "ts.net"];

/**
 * Why `host` can't be on a worker's network list, or `undefined` when it can: a lowercase host
 * name or one `*.` wildcard, never an address, port, scheme or a name that stays inside.
 */
export const workerHostProblem = (host: string): string | undefined => {
  const bare = host.startsWith("*.") ? host.slice(2) : host;
  const suffix = privateSuffixes.find((entry) => bare === entry || bare.endsWith(`.${entry}`));
  if (suffix !== undefined)
    return `ends in .${suffix}, a name for this machine, its network or its tailnet`;
  if (/^[a-z0-9-]+$/.test(host))
    return "is a single-label name, which resolves only on this machine's network";
  if (host.length > 253 || !hostName.test(host))
    return "isn't a lowercase host name such as registry.npmjs.org or *.example.com";
  return undefined;
};

/** A host a worker's commands may reach through the sandbox's proxy; see `workerHostProblem`. */
export const KinWorkerHost = Schema.String.check(
  Schema.makeFilter((value: string) => workerHostProblem(value), {
    expected: "a public host name such as registry.npmjs.org or *.example.com",
  }),
);
export type KinWorkerHost = typeof KinWorkerHost.Type;

export const KinWorkerNetworkInput = Schema.Struct({ orgId: KinOrgId });
export type KinWorkerNetworkInput = typeof KinWorkerNetworkInput.Type;
export const KinWorkerNetworkChange = Schema.Struct({ orgId: KinOrgId, host: KinWorkerHost });
export type KinWorkerNetworkChange = typeof KinWorkerNetworkChange.Type;
/** Removal also takes a refused entry's host as stored, which no longer passes `KinWorkerHost`. */
export const KinWorkerNetworkRemoval = Schema.Struct({
  orgId: KinOrgId,
  host: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
});
export type KinWorkerNetworkRemoval = typeof KinWorkerNetworkRemoval.Type;

/** A stored entry today's rules refuse; workers never get it, and removing it deletes it. */
export const KinWorkerNetworkRefused = Schema.Struct({
  host: Schema.String,
  /** What the entry was: an addition, or the removal of a host. */
  allowed: Schema.Boolean,
  reason: Schema.String,
});
export type KinWorkerNetworkRefused = typeof KinWorkerNetworkRefused.Type;

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

/** The cgroup limits each worker's own systemd scope gets; values in systemd's units. */
export const KinWorkerLimits = Schema.Struct({
  memoryMaxBytes: Schema.Number,
  tasksMax: Schema.Number,
  cpuWeight: Schema.Number,
});
export type KinWorkerLimits = typeof KinWorkerLimits.Type;

export const KinWorkerSandboxStatus = Schema.Struct({
  /** `refused`: workers don't start here at all, not even with file tools; `reason` says why. */
  state: Schema.Literals(["shell", "file_only", "refused", "unchecked"]),
  reason: Schema.String,
  /** Epoch ms of the check. */
  checkedAt: Schema.NullOr(Schema.Number),
  claudeCodeVersion: Schema.NullOr(Schema.String),
  /** What the owner can install on the host to give workers a shell. */
  install: Schema.Array(KinWorkerSandboxInstall),
  /** Whether a refused command names its host to the worker, so its report can; null if unknown. */
  namesBlockedHosts: Schema.NullOr(Schema.Boolean),
  /** Null where the host gives agents no systemd scope (macOS, no user manager), or unknown. */
  limits: Schema.NullOr(KinWorkerLimits),
  /** Why limits are off, or which systemd refused; null when all apply or nothing is known. */
  limitsNote: Schema.NullOr(Schema.String),
});
export type KinWorkerSandboxStatus = typeof KinWorkerSandboxStatus.Type;

export const KinWorkerNetwork = Schema.Struct({
  orgId: KinOrgId,
  /** What a worker started now may reach. */
  allowed: Schema.Array(KinWorkerNetworkEntry),
  /** Hosts the owner removed from Kin's defaults or the host's extras; allowing one restores it. */
  removed: Schema.Array(KinWorkerHost),
  /** Stored entries that no longer pass validation, so the owner can see and remove them. */
  refused: Schema.Array(KinWorkerNetworkRefused),
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
    payload: KinWorkerNetworkRemoval,
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
