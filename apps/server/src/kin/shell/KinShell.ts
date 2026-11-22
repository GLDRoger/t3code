import {
  KinChatError,
  KinShell as Shell,
  KinShellSection,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { SqlError, UnknownError } from "effect/sql/SqlError";

import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { accessSql } from "../people/KinAccess.ts";
import type { SectionId } from "./sections.ts";

const BUILT_INS = [
  "clients",
  "deals",
  "money",
  "invoices",
  "docs",
] as const satisfies readonly SectionId[];
const defaultShell = (): Shell => ({
  rev: 0,
  sections: BUILT_INS.map((id) => ({ id, on: true })),
});
const SectionsJson = Schema.fromJsonString(Schema.Array(KinShellSection));
const decode = Schema.decodeUnknownEffect(SectionsJson);
const encode = Schema.encodeEffect(SectionsJson);
const ordered = (sections: readonly KinShellSection[]) =>
  BUILT_INS.map((id) => sections.find((section) => section.id === id) ?? { id, on: true });

export const onIn = (shell: Shell, id: SectionId) =>
  shell.sections.find((section) => section.id === id)?.on !== false;

// Share each database's latest revision across readers, never across database instances.
const caches = new WeakMap<SqlClient.SqlClient, Map<KinOrgId, { shell?: Shell }>>();
const cacheFor = (sql: SqlClient.SqlClient) => {
  const cache = caches.get(sql) ?? new Map<KinOrgId, { shell?: Shell }>();
  caches.set(sql, cache);
  return cache;
};

const read = Effect.fn("KinShell.read")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ shellJson: string; rev: number }>`SELECT shell_json AS "shellJson", rev
    FROM kin_company_shell WHERE org_id = ${orgId}`;
  if (row === undefined) return defaultShell();
  const sections = yield* decode(row.shellJson).pipe(
    Effect.mapError(
      (cause) =>
        new SqlError({
          reason: new UnknownError({
            message: "Invalid company shell in storage.",
            cause,
          }),
        }),
    ),
  );
  return { rev: row.rev, sections: ordered(sections) };
});

export const get = Effect.fn("KinShell.get")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  // A snapshot must neither borrow a newer revision nor populate the shared cache.
  if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) return yield* read(orgId);
  const cache = cacheFor(sql);
  const slot = cache.get(orgId) ?? {};
  if (slot.shell !== undefined) return slot.shell;
  cache.set(orgId, slot);
  const shell = yield* read(orgId);
  // A commit can drop this slot while its read is in flight.
  slot.shell = shell;
  return shell;
});

export const sectionOn = Effect.fn("KinShell.sectionOn")(function* (
  orgId: KinOrgId,
  id: SectionId,
) {
  return onIn(yield* get(orgId), id);
});

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const conflict = new KinChatError({
  reason: "conflict",
  message: "Someone changed this since you opened it. Nothing was saved; open it again.",
});
const set = Effect.fn("KinShell.set")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  rev: number,
  input: readonly KinShellSection[],
) {
  const sql = yield* SqlClient.SqlClient;
  const refresh = yield* KinRefreshObserver;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const [allowed] = yield* sql`SELECT 1 FROM kin_people p
      WHERE p.org_id = ${orgId} AND p.person_id = ${personId} AND p.removed_at IS NULL
      AND ${sql.literal(accessSql("p"))} IN ('owner', 'co_owner')`;
        if (allowed === undefined)
          return yield* new KinChatError({
            reason: "not_allowed",
            message: "Only the owner or a co-owner can do that.",
          });
        const [stored] = yield* sql<{
          rev: number;
        }>`SELECT rev FROM kin_company_shell WHERE org_id = ${orgId}`;
        if (rev !== (stored?.rev ?? 0)) return yield* conflict;
        const sections = ordered(input);
        for (const { id, on } of sections) {
          if (input.filter((section) => section.id === id).length > 1)
            return yield* invalid("A section can only be set once.");
          if (on || id === "deals") continue;
          return yield* invalid(
            id === "docs" ? "Docs can't be turned off." : "That switch isn't available yet.",
          );
        }
        const next = rev + 1;
        yield* sql`INSERT INTO kin_company_shell (org_id, shell_json, rev, set_by, set_at)
      VALUES (${orgId}, ${yield* encode(sections)}, ${next}, ${personId}, ${yield* Clock.currentTimeMillis})
      ON CONFLICT (org_id) DO UPDATE SET shell_json = excluded.shell_json, rev = excluded.rev,
        set_by = excluded.set_by, set_at = excluded.set_at`;
        yield* sql.afterCommit(
          Effect.sync(() => {
            cacheFor(sql).delete(orgId);
          }),
        );
        yield* refresh.touch(orgId, "shell");
        // The open attention stream has its own counter, even though the sensed rows haven't moved.
        yield* refresh.touch(orgId, "pulse");
        return { rev: next, sections };
      }),
    )
    .pipe(
      Effect.catchTags({
        SqlError: () =>
          Effect.fail(
            new KinChatError({
              reason: "unavailable",
              message: "Kin couldn't save this company's sections.",
            }),
          ),
        SchemaError: () =>
          Effect.fail(invalid("Use a name and singular name of at most 40 characters.")),
      }),
    );
});

export class KinShell extends Context.Service<
  KinShell,
  {
    readonly get: (orgId: KinOrgId) => Effect.Effect<Shell, Effect.Error<ReturnType<typeof get>>>;
    readonly set: (
      orgId: KinOrgId,
      personId: KinPersonId,
      rev: number,
      sections: readonly KinShellSection[],
    ) => Effect.Effect<Shell, KinChatError>;
    readonly sectionOn: (
      orgId: KinOrgId,
      id: SectionId,
    ) => Effect.Effect<boolean, Effect.Error<ReturnType<typeof get>>>;
  }
>()("t3/kin/shell/KinShell") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const refresh = yield* KinRefreshObserver;
  // These wrappers supply the database and observer; the operations own the spans.
  return KinShell.of({
    get: Effect.fnUntraced(function* (orgId) {
      return yield* get(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    }),
    set: Effect.fnUntraced(function* (orgId, personId, rev, sections) {
      return yield* set(orgId, personId, rev, sections).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(KinRefreshObserver, refresh),
      );
    }),
    sectionOn: Effect.fnUntraced(function* (orgId, id) {
      return yield* sectionOn(orgId, id).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    }),
  });
});
export const layer = Layer.effect(KinShell, make);
