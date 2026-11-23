import { KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import { HOUR_MS } from "../durations.ts";
import { BACKUP_STATUS_FILE, backupProblem, checkLeadNotice } from "../hostBackup.ts";
import { KinHostCare } from "./KinHostCare.ts";

/**
 * Keeps one open notice per company while this host has no recent good backup, posted outside
 * the owner's quiet hours, and closes it once a good backup runs (`KinHostCare.checkBackup`).
 */
export const check = Effect.fn("KinHostBackup.check")(function* () {
  const care = yield* Effect.serviceOption(KinHostCare);
  if (Option.isNone(care)) return;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig;
  const now = yield* Clock.currentTimeMillis;
  const file = care.value.host
    ? yield* fs
        .readFileString(path.join(stateDir, BACKUP_STATUS_FILE))
        .pipe(Effect.option, Effect.map(Option.getOrUndefined))
    : undefined;
  const problem = backupProblem(file, now);
  // The host's backup covers every company it serves.
  const orgs = yield* sql<{
    orgId: string;
  }>`SELECT org_id AS "orgId" FROM kin_orgs ORDER BY org_id`;
  for (const row of orgs) {
    const orgId = KinOrgId.make(row.orgId);
    yield* checkLeadNotice(orgId).pipe(
      Effect.catch((cause) => Effect.logWarning("Kin no-agent notice failed", { orgId, cause })),
    );
    if (!care.value.host) continue;
    yield* care.value.checkBackup(orgId, problem);
    // Reconcile cards left open by an offline CLI retirement or an interrupted refresh.
    yield* care.value.refresh(orgId, { closedOnly: true });
  }
});

/** The lead check runs for every company. Backup checks only run on a Kin host. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const care = yield* Effect.serviceOption(KinHostCare);
    if (Option.isNone(care)) return;
    let nextAt = 0;
    yield* (yield* Scheduler.Scheduler).register(
      "kin-host-backup",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now < nextAt) return;
        nextAt = now + HOUR_MS;
        yield* check();
      }).pipe(Effect.catch((cause) => Effect.logWarning("Kin backup check failed", { cause }))),
    );
  }),
);
