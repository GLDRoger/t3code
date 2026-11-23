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

import { KinRefreshObserver, KinWorkRefresh } from "../chat/KinRefreshHub.ts";
import { accessSql } from "../people/KinAccess.ts";
import { listSectionRefused, type SectionId } from "./sections.ts";

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

/** A company list shown as a section of its own: `list:<its id>`. */
export const listSectionId = (listId: string): `list:${string}` => `list:${listId}`;
/** The list a section id names, or undefined for a built-in or unknown id. */
export const listOfSection = (id: string) =>
  /^list:[a-z][a-z0-9_]{1,39}$/.test(id) ? id.slice(5) : undefined;

/** Built-ins in their fixed order, then each list section once, in the order added. */
const ordered = (sections: readonly KinShellSection[]) => [
  ...BUILT_INS.map((id) => sections.find((section) => section.id === id) ?? { id, on: true }),
  ...sections.filter(
    (section, index) =>
      listOfSection(section.id) !== undefined &&
      sections.findIndex((one) => one.id === section.id) === index,
  ),
];

const storedOn = (shell: Shell, id: SectionId) =>
  shell.sections.find((section) => section.id === id)?.on !== false;

/** Every built-in section switched on: no tool or record is kept from an agent by the shell. */
export const builtInsOn = (shell: Shell) => BUILT_INS.every((id) => storedOn(shell, id));

/** A list is a section only while the shell names it and its switch is on. */
export const listSectionOn = (shell: Shell, listId: string) =>
  shell.sections.some((section) => section.id === listSectionId(listId) && section.on);

export const sectionOn = (shell: Shell, id: SectionId) =>
  storedOn(shell, id) &&
  (id !== "deals" || storedOn(shell, "clients")) &&
  (id !== "invoices" || (storedOn(shell, "clients") && storedOn(shell, "money")));

export const sectionName = (shell: Shell, id: SectionId) =>
  (id === "clients" ? shell.sections.find((section) => section.id === id)?.name : undefined) ??
  {
    clients: "Clients",
    deals: "Deals",
    money: "Money",
    invoices: "Invoices and quotes",
    docs: "Docs",
  }[id];

// One line of plain text: no line breaks, controls, or direction and other format marks.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const hasControl = (label: string) => label.search(UNSAFE) >= 0;
/** An older stored label is shown with what a label may not hold removed. */
const cleanLabel = (label: string | undefined) => label?.replace(UNSAFE, "").trim() || undefined;

const labelsOf = ({ id, on, name, noun, dock }: KinShellSection): KinShellSection => {
  const plural = cleanLabel(name);
  const singular = cleanLabel(noun);
  return {
    id,
    on,
    ...(id === "clients" && plural ? { name: plural } : {}),
    ...(id === "clients" && singular ? { noun: singular } : {}),
    ...(dock === undefined ? {} : { dock }),
  };
};

// Share each database's latest revision across readers, never across database instances.
const caches = new WeakMap<SqlClient.SqlClient, Map<KinOrgId, { shell?: Shell }>>();
const cacheFor = (sql: SqlClient.SqlClient) => {
  const cache = caches.get(sql) ?? new Map<KinOrgId, { shell?: Shell }>();
  caches.set(sql, cache);
  return cache;
};

export const invalidate = Effect.fn("KinShell.invalidate")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  cacheFor(sql).delete(orgId);
});

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
  return { rev: row.rev, sections: ordered(sections).map(labelsOf) };
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

export const getForDisplay = Effect.fn("KinShell.getForDisplay")((orgId: KinOrgId) =>
  get(orgId).pipe(
    Effect.catch(() =>
      Effect.logWarning("Kin couldn't read the company shell; using defaults.", { orgId }).pipe(
        Effect.as(defaultShell()),
      ),
    ),
  ),
);

export const sectionOnFor = Effect.fn("KinShell.sectionOn")(function* (
  orgId: KinOrgId,
  id: SectionId,
) {
  return sectionOn(yield* get(orgId), id);
});

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const conflict = new KinChatError({
  reason: "conflict",
  message:
    "Someone else changed the sections just now, so nothing was saved. Check them and save again.",
});
/**
 * Why the setter refuses `input` over the stored `before`, in its own words; undefined when it
 * may be saved. The setter runs it at the write; an agent's proposal runs it before its card.
 */
export const shellRefusal = (
  before: readonly KinShellSection[],
  input: readonly KinShellSection[],
): string | undefined => {
  for (const { id, on, name, noun } of ordered(input)) {
    if (input.filter((section) => section.id === id).length > 1)
      return "A section can only be set once.";
    if (id === "docs" && !on) return "Docs can't be turned off.";
    for (const label of [name, noun]) {
      if (label === undefined) continue;
      if (hasControl(label)) return "A name is one line of plain text.";
      if (label.trim().length > 40) return "A name can be at most 40 characters.";
    }
  }
  const proposed = { rev: 0, sections: ordered(input).map(labelsOf) };
  if (storedOn(proposed, "clients") || !storedOn(proposed, "invoices")) return undefined;
  const was = { rev: 0, sections: before.map(labelsOf) };
  const name = sectionName(was, "clients");
  return !storedOn(was, "clients")
    ? `Turn on ${name} first: invoices need it.`
    : `Turn off Invoices and quotes first: invoices need ${name}.`;
};

/** Why one of these list sections can't be in the shell, in the setter's words; else undefined. */
export const listSectionsRefusal = Effect.fn("KinShell.listSectionsRefusal")(function* (
  orgId: KinOrgId,
  sections: readonly KinShellSection[],
) {
  const lists = sections.flatMap((section) => listOfSection(section.id) ?? []);
  if (lists.length === 0) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const defined = yield* sql<{
    id: string;
    name: string;
    payments: number | null;
    archivedAt: number | null;
  }>`SELECT register_id AS id, name, archived_at AS "archivedAt",
      json_extract(definition_json, '$.payments') AS payments
    FROM kin_registers WHERE org_id = ${orgId} AND built_in = 0
      AND register_id IN ${sql.in(lists)} ORDER BY register_id`;
  for (const id of lists) {
    const list = defined.find((one) => one.id === id && one.archivedAt === null);
    if (list === undefined) return `There is no list ${id} to show as a section.`;
    if (listSectionRefused(list))
      return `${list.name} has its place in Kin already, so it can't be a section of its own.`;
  }
  return undefined;
});

/**
 * Writes the next revision over `before` in the caller's transaction, for every reader after it
 * commits. Open Work pages restart only when a built-in switch takes effect: a list section gates
 * no Work row, so it moves the shell and pulse topics alone, as a rename does.
 */
const save = Effect.fn("KinShell.save")(function* (
  orgId: KinOrgId,
  personId: string,
  before: Shell,
  sections: readonly KinShellSection[],
) {
  const sql = yield* SqlClient.SqlClient;
  const refresh = yield* KinRefreshObserver;
  const refreshWork = yield* KinWorkRefresh;
  const next = before.rev + 1;
  const after = { rev: next, sections };
  yield* sql`INSERT INTO kin_company_shell (org_id, shell_json, rev, set_by, set_at)
    VALUES (${orgId}, ${yield* encode(sections)}, ${next}, ${personId}, ${yield* Clock.currentTimeMillis})
    ON CONFLICT (org_id) DO UPDATE SET shell_json = excluded.shell_json, rev = excluded.rev,
      set_by = excluded.set_by, set_at = excluded.set_at`;
  yield* sql.afterCommit(invalidate(orgId));
  yield* refresh.touch(orgId, "shell");
  // The open attention stream has its own counter, even though the sensed rows haven't moved.
  yield* refresh.touch(orgId, "pulse");
  if (BUILT_INS.some((id) => sectionOn(before, id) !== sectionOn(after, id)))
    yield* refreshWork(orgId);
  return after;
});

/**
 * Shows a list as a section, switched on, in the caller's transaction: the owner-level answer on
 * the list's own card (`registers.defineList`) is who set it. `dock` given sets its dock switch.
 */
export const showList = Effect.fn("KinShell.showList")(function* (
  orgId: KinOrgId,
  listId: string,
  dock: boolean | undefined,
  personId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [stored] = yield* sql<{
    rev: number;
    shellJson: string;
  }>`SELECT rev, shell_json AS "shellJson" FROM kin_company_shell WHERE org_id = ${orgId}`;
  const current = ordered(stored === undefined ? [] : yield* decode(stored.shellJson));
  const id = listSectionId(listId);
  const shown = { id, on: true, ...(dock === undefined ? {} : { dock }) };
  const sections = current.some((section) => section.id === id)
    ? current.map((section) => (section.id === id ? { ...section, ...shown } : section))
    : [...current, shown];
  const refusal = yield* listSectionsRefusal(orgId, sections);
  if (refusal !== undefined) return yield* invalid(refusal);
  return yield* save(
    orgId,
    personId,
    { rev: stored?.rev ?? 0, sections: current },
    sections.map(labelsOf),
  );
});

export const set = Effect.fn("KinShell.set")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  rev: number,
  input: readonly KinShellSection[],
) {
  const sql = yield* SqlClient.SqlClient;
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
          shellJson: string;
        }>`SELECT rev, shell_json AS "shellJson" FROM kin_company_shell WHERE org_id = ${orgId}`;
        if (rev !== (stored?.rev ?? 0)) return yield* conflict;
        const previous =
          stored === undefined
            ? undefined
            : Option.getOrUndefined(yield* Effect.option(decode(stored.shellJson)));
        const refusal = shellRefusal(previous ?? [], input);
        if (refusal !== undefined) return yield* invalid(refusal);
        const sections = ordered(input).map(labelsOf);
        const lists = yield* listSectionsRefusal(orgId, sections);
        if (lists !== undefined) return yield* invalid(lists);
        return yield* save(orgId, personId, { rev, sections: previous ?? [] }, sections);
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
  const refreshWork = yield* KinWorkRefresh;
  // These wrappers supply the database and observer; the operations own the spans.
  return KinShell.of({
    get: Effect.fnUntraced(function* (orgId) {
      return yield* get(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    }),
    set: Effect.fnUntraced(function* (orgId, personId, rev, sections) {
      return yield* set(orgId, personId, rev, sections).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(KinRefreshObserver, refresh),
        Effect.provideService(KinWorkRefresh, refreshWork),
      );
    }),
    sectionOn: Effect.fnUntraced(function* (orgId, id) {
      return yield* sectionOnFor(orgId, id).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    }),
  });
});
export const layer = Layer.effect(KinShell, make);
