import {
  KinChatError,
  type KinMoney,
  type KinNumberingRule,
  type KinOrgId,
  type KinPersonId,
  type KinRecordState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import { ruleProblem } from "../gendocs/numbering.ts";
import {
  ImportHeader,
  type ImportEntry,
  type ImportList,
  type ImportPayment,
  ImportRow,
  type ImportClient,
  type ImportProject,
} from "./importFormat.ts";
import { type CreateInput, KinRecords, type Writer } from "./KinRecords.ts";
import { type FieldValue } from "./lists.ts";
import { dayIn, parseAmount } from "./money.ts";
import { endOfDay, ownerZone, startOfDay, workFailure } from "./recordRows.ts";
import {
  defineList,
  keyFor,
  type ListDef,
  listDef,
  numberingOf,
  type Proposal,
  proposalFor,
  storedCategoryLabels,
} from "./registers.ts";
import { undoBatch, type UndoReport } from "./importUndo.ts";

// Everything an import makes is keyed `import:<batch>:<kind>:<source>`, so a rerun makes nothing
// twice and leaves alone what someone changed since. Rows go a hundred to a transaction: a crash
// leaves whole chunks a rerun completes. A plan runs the same chunks and rolls each one back.

const CHUNK = 100;
const MAX_ROWS = 200_000;
const MAX_LINE_CHARS = 1_000_000;
const MAX_FILE_BYTES = 1_000_000_000;
const MAX_LISTED = 2_000;
const CLOSED: ReadonlyArray<KinRecordState> = ["done", "dropped"];
const NOT_ENTRIES = ["clients", "projects", "contacts", "docs"];
const IMPORTED_SERIES = "imported";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const decodeHeader = Schema.decodeUnknownEffect(Schema.fromJsonString(ImportHeader));
const decodeRow = Schema.decodeUnknownEffect(Schema.fromJsonString(ImportRow));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
class Rollback extends Schema.TaggedError<Rollback>()("KinImportRollback", {}) {}
type Failure = KinChatError | SqlError.SqlError | Schema.SchemaError;

type Counts = {
  create: number;
  unchanged: number;
  matched: number;
  changed: number;
  problems: number;
};
const zero = (): Counts => ({ create: 0, unchanged: 0, matched: 0, changed: 0, problems: 0 });
type Kind = "client" | "project" | "entry" | "payment";
export type ImportProblem = {
  /** The file's line, from 1; null for the file as a whole. */
  readonly line: number | null;
  readonly kind: Kind | "file" | "list";
  readonly source: string | null;
  readonly reason: string;
};
export type ImportReport = {
  readonly batch: string;
  readonly asOf: string | null;
  /** False for a plan, which keeps nothing. */
  readonly applied: boolean;
  readonly rows: number;
  readonly lists: ReadonlyArray<{
    readonly list: string;
    readonly name: string;
    readonly action: "create" | "extend" | "exists";
    readonly adds: ReadonlyArray<string>;
  }>;
  readonly clients: Counts;
  readonly projects: Counts;
  readonly entries: Counts;
  readonly payments: Counts;
  /** Imported before and changed in Kin since: left as they are, with their payments. */
  readonly changed: ReadonlyArray<{ readonly source: string; readonly key: string }>;
  /** What the file holds by list and currency, to check against the old system. */
  readonly money: ReadonlyArray<{
    readonly list: string;
    readonly entries: number;
    readonly total: KinMoney;
    readonly paid: KinMoney;
  }>;
  /** Open entries from before `asOf`, by list, with the oldest one's day. */
  readonly stale: ReadonlyArray<{
    readonly list: string;
    readonly open: number;
    readonly oldest: string | null;
  }>;
  readonly problems: ReadonlyArray<ImportProblem>;
  /** Problems and changed entries past the ones listed. */
  readonly more: number;
};
/** The file's lines; `fromFile` reads one from this host's disk. */
export type Lines = Stream.Stream<string, KinChatError>;
export type Progress = (done: number, of: number) => Effect.Effect<void>;

/**
 * Where an issued number sits: `OBK/2026-27/013` and `OBK/26-27/013` in the list's series for
 * 26-27, `OBK/13` in a running one, anything else in a series of its own Kin never continues.
 */
export const seriesOf = (rule: KinNumberingRule, number: string) => {
  const prefix = rule.prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  if (rule.series === "running") {
    const found = new RegExp(`^${prefix}[/-](\\d{1,9})$`).exec(number);
    if (found !== null)
      return { series: `${rule.prefix}|running`, seq: Number.parseInt(found[1]!, 10) };
  } else {
    const found = new RegExp(`^${prefix}[/-](?:\\d{2})?(\\d{2})-(\\d{2})[/-](\\d{1,9})$`).exec(
      number,
    );
    if (found !== null && (Number(found[1]) + 1) % 100 === Number(found[2]))
      return {
        series: `${rule.prefix}|${found[1]}-${found[2]}`,
        seq: Number.parseInt(found[3]!, 10),
      };
  }
  return { series: `${IMPORTED_SERIES}|${number}`, seq: 1 };
};

export class KinImport extends Context.Service<
  KinImport,
  {
    /** What `apply` would do, with nothing kept. */
    readonly plan: (
      orgId: KinOrgId,
      owner: KinPersonId,
      lines: Lines,
      progress?: Progress,
    ) => Effect.Effect<ImportReport, KinChatError>;
    readonly apply: (
      orgId: KinOrgId,
      owner: KinPersonId,
      lines: Lines,
      progress?: Progress,
    ) => Effect.Effect<ImportReport, KinChatError>;
    /** Takes a batch away: what it made that nobody changed or uses since. */
    readonly undo: (
      orgId: KinOrgId,
      owner: KinPersonId,
      batch: string,
      options: { readonly apply: boolean; readonly includeChanged: boolean },
    ) => Effect.Effect<UndoReport, KinChatError>;
    readonly fromFile: (path: string) => Lines;
  }
>()("t3/kin/work/KinImport") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const fs = yield* FileSystem.FileSystem;

  const run = Effect.fn("KinImport.run")(function* (
    orgId: KinOrgId,
    owner: KinPersonId,
    lines: Lines,
    keep: boolean,
    progress: Progress | undefined,
  ) {
    // A first pass, before anything is written: the header, the size, and no line too long.
    const scan = yield* Stream.runFold(
      lines,
      () => ({ rows: 0, at: 0, header: undefined as string | undefined, headerAt: -1, long: 0 }),
      (acc, text) => {
        acc.at += 1;
        if (text.length > MAX_LINE_CHARS && acc.long === 0) acc.long = acc.at;
        if (text.trim() === "") return acc;
        if (acc.header === undefined) {
          acc.header = text;
          acc.headerAt = acc.at;
        } else acc.rows += 1;
        return acc;
      },
    );
    if (scan.long > 0)
      return yield* invalid(`Line ${scan.long} is longer than a million characters.`);
    if (scan.rows > MAX_ROWS)
      return yield* invalid(
        `The file has ${scan.rows} rows; Kin takes up to ${MAX_ROWS} at a time. Split it into files with the same batch and import them in order.`,
      );
    if (scan.header === undefined) return yield* invalid("The file is empty.");
    const doc = yield* decodeHeader(scan.header).pipe(
      Effect.mapError((error) =>
        invalid(`The first line isn't a kin-import header: ${error.message.slice(0, 1_000)}`),
      ),
    );

    const problems: Array<ImportProblem> = [];
    let more = 0;
    const counts = { clients: zero(), projects: zero(), entries: zero(), payments: zero() };
    const SECTION = {
      client: "clients",
      project: "projects",
      entry: "entries",
      payment: "payments",
    } as const;
    const problem = (
      line: number | null,
      kind: ImportProblem["kind"],
      source: string | null,
      reason: string,
    ) => {
      if (kind in SECTION) counts[SECTION[kind as Kind]].problems += 1;
      if (problems.length < MAX_LISTED) problems.push({ line, kind, source, reason });
      else more += 1;
      return undefined;
    };

    const writer: Writer = { actor: { _tag: "person", personId: owner }, via: "import" };
    const me = { _tag: "person" as const, personId: owner };
    const zone = yield* ownerZone(orgId);
    const now = yield* Clock.currentTimeMillis;
    const today = dayIn(now, zone);
    const originOf = (kind: Kind, source: string) => `import:${doc.batch}:${kind}:${source}`;
    const at = (value: string, end = false) =>
      DAY.test(value) ? (end ? endOfDay(value, zone) : startOfDay(value, zone)) : Date.parse(value);
    const dayOf = (value: string | undefined) =>
      value === undefined ? undefined : DAY.test(value) ? value : dayIn(Date.parse(value), zone);

    const found = Effect.fn("KinImport.found")(function* (originKey: string) {
      const [row] = yield* sql<{ recordId: string; key: string }>`SELECT record_id AS "recordId",
          key FROM kin_records WHERE org_id = ${orgId} AND origin_key = ${originKey}`;
      return row;
    });
    const changed: Array<{ source: string; key: string }> = [];
    /** Made by an earlier run; `edited` when anyone but an import has changed it since. */
    const existing = Effect.fn("KinImport.existing")(function* (
      kind: "client" | "project" | "entry",
      source: string,
      tally: boolean,
    ) {
      const row = yield* found(originOf(kind, source));
      if (row === undefined) return undefined;
      const others = yield* sql`SELECT 1 FROM kin_record_changes
        WHERE org_id = ${orgId} AND record_id = ${row.recordId} AND via <> 'import' LIMIT 1`;
      const edited = others.length > 0;
      if (tally) {
        counts[SECTION[kind]][edited ? "changed" : "unchanged"] += 1;
        if (edited) {
          if (changed.length < MAX_LISTED) changed.push({ source, key: row.key });
          else more += 1;
        }
      }
      return { ...row, edited };
    });

    // Lists are made or added to, never narrowed; a plan makes them again in every chunk.
    const listReport: Array<ImportReport["lists"][number]> = [];
    const failedLists = new Set<string>();
    const defs = new Map<string, ListDef>();
    const listStep = Effect.fn("KinImport.list")(function* (spec: ImportList) {
      const def = yield* listDef(orgId, spec.list);
      if (def === undefined) {
        if (spec.template !== undefined && spec.template !== spec.list)
          return yield* invalid(`A list from the ${spec.template} template is ${spec.template}.`);
        const { list: id, ...asked } = spec;
        const made = yield* proposalFor(orgId, { ...asked, id });
        if (made._tag !== "new") return yield* invalid(`${spec.list} can't be made.`);
        const wrong = spec.numbering === undefined ? undefined : ruleProblem(spec.numbering);
        if (wrong !== undefined) return yield* invalid(wrong);
        if (spec.payments === true && !made.definition.amount)
          return yield* invalid(`${made.name} has no amounts, so nothing to pay over time.`);
        const categoryLabels = storedCategoryLabels(made.id, {
          ...made.definition.categoryLabels,
          ...spec.categoryLabels,
        });
        const proposal: Proposal = {
          ...made,
          definition: {
            ...made.definition,
            ...(Object.keys(categoryLabels).length === 0 ? {} : { categoryLabels }),
            ...(spec.payments === true ? { payments: true as const } : {}),
            ...(spec.numbering === undefined ? {} : { numbering: spec.numbering }),
          },
        };
        yield* defineList(orgId, proposal, now);
        return {
          list: spec.list,
          name: proposal.name,
          action: "create" as const,
          adds: proposal.definition.fields.map((one) => one.label),
        };
      }
      if (def.builtIn !== null) {
        if ((spec.fields ?? []).length > 0 || (spec.categories ?? []).length > 0)
          return yield* invalid(`${def.name} is built in; its fields and kinds are fixed.`);
        return { list: def.id, name: def.name, action: "exists" as const, adds: [] };
      }
      const fields: Array<NonNullable<ImportList["fields"]>[number]> = [];
      const choices: Record<string, ReadonlyArray<string>> = {};
      const adds: Array<string> = [];
      for (const one of spec.fields ?? []) {
        const had = def.fields.find((field) => field.key === keyFor(one.label));
        if (had === undefined) {
          fields.push(one);
          adds.push(one.label);
        } else if (had.type !== one.type)
          return yield* invalid(`${def.name} has ${had.label} as ${had.type}, not ${one.type}.`);
        else if (had.type === "choice") {
          const fresh = (one.choices ?? []).filter((item) => !(had.choices ?? []).includes(item));
          if (fresh.length > 0) {
            choices[had.key] = fresh;
            adds.push(...fresh.map((item) => `${had.label}: ${item}`));
          }
        }
      }
      const categories = (spec.categories ?? []).filter((one) => !def.categories.includes(one));
      adds.push(...categories);
      if (adds.length === 0)
        return { list: def.id, name: def.name, action: "exists" as const, adds };
      const extension = yield* proposalFor(orgId, { list: def.id, fields });
      if (extension._tag !== "extend") return yield* invalid(`${def.name} can't be added to.`);
      yield* defineList(orgId, { ...extension, categories, choices }, now);
      return { list: def.id, name: def.name, action: "extend" as const, adds };
    });
    const defineLists = Effect.fn("KinImport.lists")(function* (tally: boolean) {
      for (const spec of doc.lists ?? []) {
        if (failedLists.has(spec.list)) continue;
        const outcome = yield* sql.withTransaction(listStep(spec)).pipe(
          Effect.catchTags({
            KinChatError: (error) => {
              failedLists.add(spec.list);
              return Effect.succeed(
                tally ? problem(null, "list", spec.list, error.message) : undefined,
              );
            },
          }),
        );
        if (tally && outcome !== undefined) listReport.push(outcome);
      }
    });
    /** A list as it stands; a plan's lists read the same in every chunk, so one read serves. */
    const listOf = Effect.fn("KinImport.listOf")(function* (id: string) {
      const cached = defs.get(id);
      if (cached !== undefined) return cached;
      const def = yield* listDef(orgId, id);
      if (def !== undefined) defs.set(id, def);
      return def;
    });

    const clients = new Map<string, ImportClient>();
    const projects = new Map<string, ImportProject>();
    const seen = { entry: new Set<string>(), payment: new Set<string>() };
    const failed = { client: new Set<string>(), project: new Set<string>() };
    /** One row in its own savepoint: a refusal undoes only it and becomes its problem line. */
    const row = <A, R>(
      line: number,
      kind: Kind,
      source: string,
      effect: Effect.Effect<A, Failure, R>,
      onFail?: () => void,
    ) =>
      sql.withTransaction(effect).pipe(
        Effect.catchTags({
          KinChatError: (error) => {
            onFail?.();
            return Effect.succeed(problem(line, kind, source, error.message));
          },
        }),
      );
    const dates = (createdAt: string | undefined, closedAt: string | undefined) => ({
      ...(createdAt === undefined ? {} : { createdAt: at(createdAt) }),
      ...(closedAt === undefined ? {} : { closedAt: at(closedAt, true) }),
    });

    /** A client's record id, made if need be: a plan's earlier chunk was rolled back. */
    const client = Effect.fn("KinImport.client")(function* (
      line: number,
      source: string,
      tally: boolean,
    ) {
      const spec = clients.get(source);
      if (spec === undefined) return (yield* found(originOf("client", source)))?.recordId;
      if (failed.client.has(source)) return undefined;
      const had = yield* existing("client", source, tally);
      if (had !== undefined) return had.recordId;
      const [same] = yield* sql<{ recordId: string }>`SELECT record_id AS "recordId"
        FROM kin_records WHERE org_id = ${orgId} AND register_id = 'clients'
          AND state NOT IN ${sql.in(CLOSED)} AND lower(title) = lower(${spec.name})
          ORDER BY key LIMIT 1`;
      if (same !== undefined) {
        if (tally) counts.clients.matched += 1;
        return same.recordId;
      }
      const fields = Object.fromEntries(
        (["gstin", "address", "terms", "placeOfSupply"] as const).flatMap((key) => {
          const value = spec[key];
          return value === undefined ? [] : [[key, value] as const];
        }),
      );
      const created = yield* row(
        line,
        "client",
        source,
        records.create(orgId, writer, {
          list: "clients",
          originKey: originOf("client", source),
          title: spec.name,
          owner: me,
          category: spec.kind ?? "client",
          ...(spec.state === undefined ? {} : { state: spec.state }),
          ...(spec.notes === undefined ? {} : { notes: spec.notes }),
          ...(spec.sensitive === undefined ? {} : { sensitive: spec.sensitive }),
          fields,
          ...dates(spec.createdAt, spec.createdAt),
        }),
        () => failed.client.add(source),
      );
      if (created === undefined) return undefined;
      if (tally) counts.clients.create += 1;
      return created.row.recordId;
    });

    const project = Effect.fn("KinImport.project")(function* (
      line: number,
      source: string,
      tally: boolean,
    ) {
      const spec = projects.get(source);
      if (spec === undefined) return (yield* found(originOf("project", source)))?.recordId;
      if (failed.project.has(source)) return undefined;
      const had = yield* existing("project", source, tally);
      if (had !== undefined) return had.recordId;
      const partyId = spec.client === undefined ? null : yield* client(line, spec.client, false);
      if (partyId === undefined) {
        failed.project.add(source);
        return problem(
          line,
          "project",
          source,
          `Its client ${spec.client} isn't above it or imported before.`,
        );
      }
      const created = yield* row(
        line,
        "project",
        source,
        records.create(orgId, writer, {
          list: "projects",
          originKey: originOf("project", source),
          title: spec.name,
          owner: me,
          partyId,
          ...(spec.state === undefined ? {} : { state: spec.state }),
          ...(spec.target === undefined ? {} : { dueAt: at(spec.target, true), dueAllDay: true }),
          ...(spec.notes === undefined ? {} : { notes: spec.notes }),
          ...(spec.sensitive === undefined ? {} : { sensitive: spec.sensitive }),
          ...dates(spec.createdAt, spec.closedAt ?? spec.createdAt),
        }),
        () => failed.project.add(source),
      );
      if (created === undefined) return undefined;
      if (tally) counts.projects.create += 1;
      return created.row.recordId;
    });

    /** A field's value as Kin stores it, with what it points at resolved in this org. */
    const fieldValue = Effect.fn("KinImport.fieldValue")(function* (
      line: number,
      def: ListDef,
      key: string,
      value: string | { readonly amount: string; readonly currency: string },
    ) {
      const spec = def.fields.find((one) => one.key === key);
      if (typeof value !== "string") {
        if (spec !== undefined && spec.type !== "money")
          return yield* invalid(`${spec.label} isn't an amount.`);
        const money = parseAmount(value.amount, value.currency);
        if ("error" in money) return yield* money.error;
        return money.money;
      }
      if (spec?.type === "file")
        return yield* invalid(`${spec.label} holds files; Kin doesn't import files.`);
      if (spec?.type === "person") {
        if (value !== "owner") return yield* invalid(`${spec.label} takes "owner".`);
        return `person:${owner}`;
      }
      if (spec?.type === "link") {
        const projectLink = spec.link === "projects";
        const id = projectLink
          ? yield* project(line, value, false)
          : yield* client(line, value, false);
        if (id === undefined || id === null)
          return yield* invalid(
            `${spec.label}: no ${projectLink ? "project" : "client"} ${value} here.`,
          );
        return id;
      }
      return value;
    });

    /** Payments by this import's keys; one recorded before is passed over. */
    const payAll = Effect.fn("KinImport.payAll")(function* (
      line: number,
      due: ReadonlyArray<ImportPayment>,
      key: string,
      currency: string,
    ) {
      for (const payment of due)
        yield* row(
          line,
          "payment",
          payment.source,
          Effect.gen(function* () {
            const originKey = originOf("payment", payment.source);
            const before = yield* sql`SELECT 1 FROM kin_record_payments
              WHERE org_id = ${orgId} AND origin_key = ${originKey} LIMIT 1`;
            const amount = parseAmount(payment.amount, payment.currency ?? currency);
            if ("error" in amount) return yield* amount.error;
            yield* records.pay(orgId, writer, key, {
              amount: amount.money,
              paidOn: payment.paidOn,
              ...(payment.note === undefined ? {} : { note: payment.note }),
              originKey,
            });
            counts.payments[before.length > 0 ? "unchanged" : "create"] += 1;
          }),
        );
    });

    /** Keeps a number the old system issued, and moves Kin's own series past it. */
    const keepNumber = Effect.fn("KinImport.keepNumber")(function* (
      registerId: string,
      recordId: string,
      number: string,
      rule: KinNumberingRule,
      issuedAt: number,
    ) {
      const { series, seq } = seriesOf(rule, number);
      const clash = yield* sql`SELECT 1 FROM kin_issued_numbers WHERE org_id = ${orgId}
        AND register_id = ${registerId}
        AND (number = ${number} OR (series = ${series} AND seq = ${seq})) LIMIT 1`;
      if (clash.length > 0) return yield* invalid(`${number} is already issued in Kin.`);
      yield* sql`INSERT INTO kin_issued_numbers (org_id, register_id, series, seq, number,
          record_id, issued_at, issued_by_kind, issued_by_id)
        VALUES (${orgId}, ${registerId}, ${series}, ${seq}, ${number}, ${recordId}, ${issuedAt},
          'person', ${owner})`;
      if (!series.startsWith(`${IMPORTED_SERIES}|`))
        yield* sql`INSERT INTO kin_number_series (org_id, register_id, series, last_seq)
          VALUES (${orgId}, ${registerId}, ${series}, ${seq})
          ON CONFLICT (org_id, register_id, series) DO UPDATE
            SET last_seq = MAX(kin_number_series.last_seq, excluded.last_seq)`;
    });

    const money = new Map<
      string,
      { list: string; currency: string; entries: number; total: bigint; paid: bigint }
    >();
    const stale = new Map<string, { open: number; oldest: string | null }>();
    const paidOf = (due: ReadonlyArray<ImportPayment>, currency: string) =>
      due.reduce((sum, one) => {
        const paid = parseAmount(one.amount, one.currency ?? currency);
        return sum + ("money" in paid ? BigInt(paid.money.minor) : 0n);
      }, 0n);
    /** What the owner compares with the old system: every entry of the file that came in. */
    const tally = (
      spec: ImportEntry,
      def: ListDef,
      amount: KinMoney | undefined,
      open: boolean,
    ) => {
      if (amount !== undefined) {
        const slot = `${def.id}|${amount.currency}`;
        const sum = money.get(slot) ?? {
          list: def.id,
          currency: amount.currency,
          entries: 0,
          total: 0n,
          paid: 0n,
        };
        sum.entries += 1;
        sum.total += BigInt(amount.minor);
        sum.paid += paidOf(spec.payments ?? [], amount.currency);
        money.set(slot, sum);
      }
      if (!open || doc.asOf === undefined) return;
      const last = dayOf(spec.date) ?? dayOf(spec.createdAt) ?? dayOf(spec.due);
      if (last !== undefined && last >= doc.asOf) return;
      const one = stale.get(def.id) ?? { open: 0, oldest: null };
      one.open += 1;
      if (last !== undefined && (one.oldest === null || last < one.oldest)) one.oldest = last;
      stale.set(def.id, one);
    };

    const entry = Effect.fn("KinImport.entry")(function* (line: number, spec: ImportEntry) {
      const due = (spec.payments ?? []).filter((payment) => {
        if (!seen.payment.has(payment.source)) {
          seen.payment.add(payment.source);
          return true;
        }
        problem(line, "payment", payment.source, "Another payment has this source id.");
        return false;
      });
      const fail = (reason: string) => {
        for (const payment of due)
          problem(
            line,
            "payment",
            payment.source,
            `Its entry ${spec.source} couldn't be imported.`,
          );
        return problem(line, "entry", spec.source, reason);
      };
      if (seen.entry.has(spec.source)) return fail("Another entry has this source id.");
      seen.entry.add(spec.source);
      if (NOT_ENTRIES.includes(spec.list))
        return fail(
          `Entries don't go on ${spec.list}; clients and projects have rows of their own.`,
        );
      if (failedLists.has(spec.list)) return fail(`Its list ${spec.list} couldn't be made.`);
      const def = yield* listOf(spec.list);
      if (def === undefined) return fail(`There is no list ${spec.list}; name it in the header.`);
      const currency = spec.currency ?? def.currency;
      const parsed = spec.amount === undefined ? undefined : parseAmount(spec.amount, currency);
      if (parsed !== undefined && "error" in parsed) return fail(parsed.error.message);
      const amount = parsed?.money;
      const open =
        !CLOSED.includes(spec.state ?? def.defaultState) &&
        (amount === undefined ||
          due.length === 0 ||
          paidOf(due, amount.currency) !== BigInt(amount.minor));
      const had = yield* existing("entry", spec.source, true);
      if (had !== undefined) {
        if (had.edited) counts.payments.changed += due.length;
        else yield* payAll(line, due, had.key, currency);
        return tally(spec, def, amount, open);
      }
      const partyId =
        spec.client === undefined ? undefined : yield* client(line, spec.client, false);
      if (spec.client !== undefined && partyId === undefined)
        return fail(`Its client ${spec.client} isn't above it or imported before.`);
      const projectId =
        spec.project === undefined ? undefined : yield* project(line, spec.project, false);
      if (spec.project !== undefined && (projectId === undefined || projectId === null))
        return fail(`Its project ${spec.project} isn't above it or imported before.`);
      const notes = [
        spec.notes ?? "",
        open && doc.asOf !== undefined
          ? `Imported from ${doc.source ?? doc.batch} on ${today}. Those records were last kept up on ${doc.asOf}, so check this is still current.`
          : "",
      ]
        .filter((part) => part !== "")
        .join("\n\n");
      const made = yield* row(
        line,
        "entry",
        spec.source,
        Effect.gen(function* () {
          const fields: Record<string, FieldValue> = {};
          for (const [key, value] of Object.entries(spec.fields ?? {}))
            fields[key] = yield* fieldValue(line, def, key, value);
          const rule = numberingOf(def);
          if (spec.number !== undefined) {
            if (rule === undefined)
              return yield* invalid(
                `${def.name} doesn't number its entries; keep the number in a field.`,
              );
            if (def.fields.some((one) => one.key === "number")) fields.number = spec.number;
          }
          const dateAt = spec.date === undefined ? undefined : at(spec.date, true);
          const createdAt = spec.createdAt === undefined ? undefined : at(spec.createdAt);
          const input: CreateInput = {
            list: def.id,
            originKey: originOf("entry", spec.source),
            title: spec.title,
            owner: me,
            state: spec.state ?? def.defaultState,
            ...(spec.category === undefined ? {} : { category: spec.category }),
            ...(partyId === undefined ? {} : { partyId }),
            ...(projectId === undefined || projectId === null ? {} : { projectId }),
            ...(spec.due === undefined
              ? {}
              : { dueAt: at(spec.due, true), dueAllDay: DAY.test(spec.due) }),
            ...(dateAt === undefined ? {} : { dateAt, dateAllDay: DAY.test(spec.date ?? "") }),
            ...(amount === undefined ? {} : { amount }),
            ...(notes === "" ? {} : { notes }),
            ...(spec.sensitive === undefined ? {} : { sensitive: spec.sensitive }),
            fields,
            ...(createdAt === undefined ? {} : { createdAt }),
            closedAt:
              spec.closedAt === undefined ? (dateAt ?? createdAt ?? now) : at(spec.closedAt, true),
          };
          const { row: record } = yield* records.create(orgId, writer, input);
          if (spec.number !== undefined && rule !== undefined)
            yield* keepNumber(
              def.id,
              record.recordId,
              spec.number,
              rule,
              dateAt ?? createdAt ?? now,
            );
          yield* payAll(line, due, record.key, record.currency ?? currency);
          // Paid in full, it closed on its last payment's day, not today.
          const last = due
            .map((one) => one.paidOn)
            .toSorted()
            .at(-1);
          if (last !== undefined && spec.closedAt === undefined)
            yield* sql`UPDATE kin_records SET closed_at = ${endOfDay(last, zone)}
              WHERE org_id = ${orgId} AND record_id = ${record.recordId} AND state = 'done'`;
          return record.key;
        }),
        () => {
          for (const payment of due)
            problem(
              line,
              "payment",
              payment.source,
              `Its entry ${spec.source} couldn't be imported.`,
            );
        },
      );
      if (made === undefined) return;
      counts.entries.create += 1;
      tally(spec, def, amount, open);
    });

    const rowStep = Effect.fn("KinImport.row")(function* (text: string, line: number) {
      const decoded = yield* decodeRow(text).pipe(Effect.result);
      if (decoded._tag === "Failure")
        return problem(
          line,
          "file",
          null,
          `This line doesn't fit the format: ${decoded.failure.message.slice(0, 500)}`,
        );
      const one = decoded.success;
      if ("client" in one) {
        if (clients.has(one.client.source))
          return problem(line, "client", one.client.source, "Another client has this source id.");
        clients.set(one.client.source, one.client);
        return yield* client(line, one.client.source, true);
      }
      if ("project" in one) {
        if (projects.has(one.project.source))
          return problem(
            line,
            "project",
            one.project.source,
            "Another project has this source id.",
          );
        projects.set(one.project.source, one.project);
        return yield* project(line, one.project.source, true);
      }
      return yield* entry(line, one.entry);
    });

    const rolledBack = <A, R>(work: Effect.Effect<A, Failure, R>) =>
      sql
        .withTransaction(work.pipe(Effect.andThen(Effect.fail(new Rollback()))))
        .pipe(Effect.catchTags({ KinImportRollback: () => Effect.void }));

    // The run's own row commits with its lists, so an undo knows which lists the batch made.
    const begin = Effect.gen(function* () {
      yield* defineLists(true);
      if (!keep) return undefined;
      const made = listReport.filter((one) => one.action === "create").map((one) => one.list);
      const [started] = yield* sql<{ seq: number }>`INSERT INTO kin_import_runs (org_id, batch,
          action, person_id, started_at, lists_json)
        VALUES (${orgId}, ${doc.batch}, 'apply', ${owner}, ${now}, ${encodeJson(made)})
        RETURNING seq`;
      return started?.seq;
    });
    const runSeq = keep
      ? yield* sql.withTransaction(begin)
      : yield* rolledBack(begin).pipe(Effect.as(undefined));

    let done = 0;
    yield* lines.pipe(
      Stream.zipWithIndex,
      Stream.grouped(CHUNK),
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          const work = Effect.gen(function* () {
            if (!keep) yield* defineLists(false);
            for (const [text, index] of chunk)
              if (index + 1 > scan.headerAt && text.trim() !== "") yield* rowStep(text, index + 1);
          });
          if (keep) yield* sql.withTransaction(work);
          else yield* rolledBack(work);
          done += chunk.filter(
            ([text, index]) => index + 1 > scan.headerAt && text.trim() !== "",
          ).length;
          if (progress !== undefined) yield* progress(done, scan.rows);
        }),
      ),
    );

    const asMoney = (minor: bigint, currency: string): KinMoney => ({
      minor: Number(minor),
      currency,
    });
    const byName = <A>(rows: Iterable<readonly [string, A]>) =>
      [...rows].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const report: ImportReport = {
      batch: doc.batch,
      asOf: doc.asOf ?? null,
      applied: keep,
      rows: scan.rows,
      lists: listReport,
      ...counts,
      changed,
      money: byName(money).map(([, one]) => ({
        list: one.list,
        entries: one.entries,
        total: asMoney(one.total, one.currency),
        paid: asMoney(one.paid, one.currency),
      })),
      stale: byName(stale).map(([list, one]) => ({ list, ...one })),
      problems,
      more,
    };
    if (runSeq !== undefined) {
      const finished = yield* Clock.currentTimeMillis;
      yield* sql`UPDATE kin_import_runs SET finished_at = ${finished},
          summary_json = ${encodeJson({ ...counts, rows: scan.rows })}
        WHERE seq = ${runSeq}`;
    }
    return report;
  }, workFailure);

  const fromFile = (path: string): Lines =>
    Stream.unwrap(
      Effect.gen(function* () {
        const info = yield* fs
          .stat(path)
          .pipe(Effect.mapError(() => invalid(`Kin can't read ${path}.`)));
        if (info.type !== "File") return yield* invalid(`${path} isn't a file.`);
        if (Number(info.size) > MAX_FILE_BYTES)
          return yield* invalid(
            `${path} is over a gigabyte. Split it into files with the same batch.`,
          );
        return fs.stream(path).pipe(
          Stream.mapError(() => invalid(`Kin couldn't read ${path} to the end.`)),
          Stream.decodeText,
          Stream.splitLines,
        );
      }),
    );

  return KinImport.of({
    plan: Effect.fn("KinImport.plan")(function* (orgId, owner, lines, progress) {
      return yield* run(orgId, owner, lines, false, progress).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    }),
    apply: Effect.fn("KinImport.apply")(function* (orgId, owner, lines, progress) {
      return yield* run(orgId, owner, lines, true, progress).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    }),
    undo: Effect.fn("KinImport.undo.run")(function* (orgId, owner, batch, options) {
      return yield* undoBatch(orgId, owner, batch, options).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    }),
    fromFile,
  });
});

export const layer = Layer.effect(KinImport, make);
