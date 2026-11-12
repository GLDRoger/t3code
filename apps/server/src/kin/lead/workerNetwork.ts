import {
  KinChatError,
  type KinOrgId,
  type KinWorkerNetwork,
  type KinWorkerNetworkChange,
  type KinWorkerNetworkEntry,
  type KinWorkerNetworkInput,
  type KinWorkerSandboxStatus,
  workerHostProblem,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError, type SqlError } from "effect/sql/SqlError";

import { ServerConfig } from "../../config.ts";
import type { KinIdentity, PersonIdentity } from "../chat/KinIdentity.ts";
import { theOwner } from "../work/ownerWork.ts";
import { hostShell, readStatus } from "./workSandbox.ts";

/**
 * What a worker's shell reaches with no change from the owner: where package managers and git
 * fetch code. Each is a download source for a common toolchain; none is a place to store data
 * except GitHub, which a worker needs to clone and which the PR's self-review names as a residual.
 */
export const DEFAULT_WORKER_HOSTS = [
  // npm's registry serves metadata and tarballs; Yarn 1 lockfiles name its mirror.
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  // PyPI's index, and the CDN pip downloads its files from.
  "pypi.org",
  "files.pythonhosted.org",
  // Cargo: the API, the sparse index it reads, and the CDN crates download from.
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  // Go's module proxy and the checksum database `go` verifies every module against.
  "proxy.golang.org",
  "sum.golang.org",
  // Ubuntu's archives. Commands have no root, so this serves `apt-get download` and `source`.
  "archive.ubuntu.com",
  "security.ubuntu.com",
  // GitHub: clones, archive tarballs, raw files, and the hosts release and LFS downloads use.
  "github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
] as const;

export type Requirements = SqlClient.SqlClient | KinIdentity | ServerConfig | FileSystem.FileSystem;

const defaults: ReadonlyArray<string> = DEFAULT_WORKER_HOSTS;
const MAX_OWNER_HOSTS = 100;

const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
const tooMany = new KinChatError({
  reason: "limit",
  message: `Workers can reach at most ${MAX_OWNER_HOSTS} hosts beside Kin's defaults. Remove one first.`,
});

const extras = (env: NodeJS.ProcessEnv) => {
  const host = hostShell(env);
  return host._tag === "on" ? host.domains : [];
};

const rows = Effect.fn("KinWorkerNetwork.rows")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ host: string; allowed: number }>`SELECT host, allowed
    FROM kin_worker_network WHERE org_id = ${orgId} ORDER BY host`;
});

/** Kin's defaults, then the owner's additions, then the host's extras; a removal beats each. */
export const workerHosts = Effect.fn("KinWorkerNetwork.hosts")(function* (orgId: KinOrgId) {
  // A row an older check let in is skipped, not served: the list never fails to load.
  const stored = (yield* rows(orgId)).filter((row) => workerHostProblem(row.host) === undefined);
  const removed = stored.filter((row) => row.allowed === 0).map((row) => row.host);
  const allowed: Array<KinWorkerNetworkEntry> = [];
  const add = (host: string, source: KinWorkerNetworkEntry["source"]) => {
    if (!removed.includes(host) && !allowed.some((entry) => entry.host === host))
      allowed.push({ host, source });
  };
  for (const host of defaults) add(host, "default");
  for (const row of stored) if (row.allowed === 1) add(row.host, "owner");
  for (const host of extras(yield* HostProcess.Environment)) add(host, "host");
  return { allowed, removed };
});

const sandboxStatus = Effect.fn("KinWorkerNetwork.sandboxStatus")(function* () {
  const { stateDir } = yield* ServerConfig;
  const last = yield* readStatus(stateDir);
  return Option.match(last, {
    onNone: (): KinWorkerSandboxStatus => ({
      state: "unchecked",
      reason: "No worker has started on this host since it began keeping the check.",
      checkedAt: null,
      claudeCodeVersion: null,
      install: [],
      namesBlockedHosts: null,
      limits: null,
    }),
    onSome: (status): KinWorkerSandboxStatus => ({
      state: status.shell ? "shell" : "file_only",
      reason: status.reason,
      checkedAt: status.checkedAt,
      claudeCodeVersion: status.claudeCodeVersion,
      install: status.install ?? [],
      namesBlockedHosts: status.namesBlockedHosts ?? null,
      limits: status.limits ?? null,
    }),
  });
});

const view = Effect.fn("KinWorkerNetwork.view")(function* (orgId: KinOrgId) {
  const { allowed, removed } = yield* workerHosts(orgId);
  return { orgId, allowed, removed, sandbox: yield* sandboxStatus() } satisfies KinWorkerNetwork;
});

const save = Effect.fn("KinWorkerNetwork.save")(function* (
  orgId: KinOrgId,
  host: string,
  allowed: 0 | 1 | null,
  by: string,
) {
  const sql = yield* SqlClient.SqlClient;
  if (allowed === null)
    return yield* sql`DELETE FROM kin_worker_network WHERE org_id = ${orgId} AND host = ${host}`;
  const at = yield* Clock.currentTimeMillis;
  yield* sql`INSERT INTO kin_worker_network (org_id, host, allowed, changed_at, changed_by)
    VALUES (${orgId}, ${host}, ${allowed}, ${at}, ${by})
    ON CONFLICT (org_id, host) DO UPDATE SET allowed = excluded.allowed,
      changed_at = excluded.changed_at, changed_by = excluded.changed_by`;
});

const sqlFailure = <A, R>(effect: Effect.Effect<A, KinChatError | SqlError, R>) =>
  effect.pipe(
    Effect.catchIf(isSqlError, (cause) =>
      Effect.logWarning("Kin worker network unavailable", { cause }).pipe(
        Effect.andThen(Effect.fail(unavailable)),
      ),
    ),
  );

/** Owner only, like Work: a teammate, an agent or a worker never reaches these. */
export const get = Effect.fn("KinWorkerNetwork.get")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkerNetworkInput,
) {
  yield* theOwner(people, input.orgId);
  return yield* view(input.orgId);
}, sqlFailure);

export const allow = Effect.fn("KinWorkerNetwork.allow")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkerNetworkChange,
) {
  const owner = yield* theOwner(people, input.orgId);
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (defaults.includes(input.host))
        return yield* save(input.orgId, input.host, null, owner.personId);
      const added = (yield* rows(input.orgId)).filter(
        (row) => row.allowed === 1 && row.host !== input.host,
      );
      if (added.length >= MAX_OWNER_HOSTS) return yield* tooMany;
      yield* save(input.orgId, input.host, 1, owner.personId);
    }),
  );
  return yield* view(input.orgId);
}, sqlFailure);

export const remove = Effect.fn("KinWorkerNetwork.remove")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkerNetworkChange,
) {
  const owner = yield* theOwner(people, input.orgId);
  // Only a row can hide a default or the host's extra; the owner's own addition just goes.
  const listed =
    defaults.includes(input.host) || extras(yield* HostProcess.Environment).includes(input.host);
  yield* save(input.orgId, input.host, listed ? 0 : null, owner.personId);
  return yield* view(input.orgId);
}, sqlFailure);
