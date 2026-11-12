// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous file hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  KinChatError,
  KinImportDocument,
  type KinImportInput,
  type KinImportEntry,
  type KinImportList,
  type KinImportPayment,
  type KinImportProblem,
  type KinImportReport,
  type KinImportSection,
  type KinMoney,
  type KinNumberingRule,
  type KinOrgId,
  type KinPersonId,
  KinRecordKey,
  type KinRecordState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import { ownsPendingUpload, type PendingUploadOwner } from "../../assets/AttachmentUpload.ts";
import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import { keepOrgFile } from "../chat/KinAttachmentStore.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { ruleProblem } from "../gendocs/numbering.ts";
import { keptType, typeMismatch } from "../gendocs/returnPath.ts";
import { type ProfilePatch, readProfile, setProfile } from "./companyProfile.ts";
import { type Bundle, hostBundle, zipBundle } from "./importBundle.ts";
import { type CreateInput, KinRecords, type Writer } from "./KinRecords.ts";
import { type FieldValue, parseFields } from "./lists.ts";
import { dayIn, parseAmount } from "./money.ts";
import { theOwner } from "./ownerWork.ts";
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

// A plan runs the whole import and rolls it back; apply keeps it, a hundred rows a transaction.
// All it makes is keyed `import:<batch>:<section>:<source>`, so a rerun makes nothing twice and
// leaves alone what someone changed since. Entries are the importing owner's: nothing wakes.

const CHUNK = 100;
const MAX_PROBLEMS = 2_000;
const MAX_FILES_PER_FIELD = 10;
const CLOSED: ReadonlyArray<KinRecordState> = ["done", "dropped"];
const IMPORTED_SERIES = "imported";
const KEPT_TYPES = "PDF, PNG, JPEG, WebP, SVG, CSV, XLSX, DOCX, PPTX, Markdown, text and JSON";
const COMPANY_FIELDS = [
  "legalName",
  "tradeName",
  "address",
  "gstin",
  "pan",
  "placeOfSupply",
  "sac",
] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SINGULAR = { clients: "client", projects: "project", entries: "entry" } as const;

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(KinImportDocument));
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
type Found = { readonly recordId: string; readonly key: string };
/** An entry the files can go on: made by this run, or by an earlier one. */
type Target = {
  readonly list: string;
  /** Unset in a plan for an entry it would make. */
  readonly key: string | undefined;
  readonly edited: boolean;
  readonly fields: Readonly<Record<string, FieldValue>>;
};

/**
 * Where an issued number sits: `QST/2026-27/013` and `QST/26-27/013` in the list's series for
 * 26-27, `QST/13` in a running one, anything else in a series of its own Kin never continues.
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
      bundle: Bundle,
    ) => Effect.Effect<KinImportReport, KinChatError>;
    readonly apply: (
      orgId: KinOrgId,
      owner: KinPersonId,
      bundle: Bundle,
    ) => Effect.Effect<KinImportReport, KinChatError>;
    /** A ZIP the caller uploaded and still holds as a pending upload. */
    readonly fromUpload: (
      uploader: PendingUploadOwner,
      attachmentId: string,
    ) => Effect.Effect<Bundle, KinChatError>;
    /** A folder or a ZIP on this host. */
    readonly fromHost: (path: string) => Effect.Effect<Bundle, KinChatError>;
  }
>()("t3/kin/work/KinImport") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const platform = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig.ServerConfig, config),
    );

  const run = Effect.fn("KinImport.run")(function* (
    orgId: KinOrgId,
    owner: KinPersonId,
    bundle: Bundle,
    keep: boolean,
  ) {
    const problems: Array<KinImportProblem> = [];
    let moreProblems = 0;
    const counts = {
      clients: zero(),
      projects: zero(),
      entries: zero(),
      payments: zero(),
      files: zero(),
    };
    const problem = (section: KinImportSection, source: string | null, reason: string) => {
      if (section in counts) counts[section as keyof typeof counts].problems += 1;
      if (problems.length < MAX_PROBLEMS) problems.push({ section, source, reason });
      else moreProblems += 1;
      return undefined;
    };
    const unread = (reason: string): KinImportReport => {
      problem("file", null, reason.slice(0, 2_000));
      return {
        batch: "",
        asOf: null,
        applied: false,
        lists: [],
        company: [],
        ...counts,
        changed: [],
        money: [],
        stale: [],
        problems,
        moreProblems,
      };
    };
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bundle.json),
      catch: () => undefined,
    }).pipe(Effect.result);
    if (text._tag === "Failure") return unread("import.json isn't UTF-8 text.");
    const decoded = yield* decodeDocument(text.success).pipe(Effect.result);
    if (decoded._tag === "Failure")
      return unread(`import.json doesn't fit the format: ${decoded.failure.message}`);
    const doc = decoded.success;

    const writer: Writer = { actor: { _tag: "person", personId: owner }, via: "import" };
    const me = { _tag: "person" as const, personId: owner };
    const zone = yield* ownerZone(orgId);
    const now = yield* Clock.currentTimeMillis;
    const today = dayIn(now, zone);
    const originOf = (section: string, source: string) =>
      `import:${doc.batch}:${section}:${source}`;
    const at = (value: string, end = false) =>
      DAY.test(value) ? (end ? endOfDay(value, zone) : startOfDay(value, zone)) : Date.parse(value);
    const dayOf = (value: string | undefined) =>
      value === undefined ? undefined : DAY.test(value) ? value : dayIn(Date.parse(value), zone);

    /** A section's rows by source id; a repeated id is a problem and the first one counts. */
    const unique = <A extends { readonly source: string }>(
      section: KinImportSection,
      rows: ReadonlyArray<A> | undefined,
    ) => {
      const seen = new Map<string, A>();
      for (const row of rows ?? []) {
        if (seen.has(row.source)) problem(section, row.source, "Another row has this source id.");
        else seen.set(row.source, row);
      }
      return seen;
    };
    const clients = unique("clients", doc.clients);
    const projects = unique("projects", doc.projects);
    const entries = unique("entries", doc.entries);
    const payments = unique("payments", doc.payments);
    const files = unique("files", doc.files);
    const byEntry = new Map<string, Array<KinImportPayment>>();
    for (const payment of payments.values())
      byEntry.set(payment.entry, [...(byEntry.get(payment.entry) ?? []), payment]);

    const found = Effect.fn("KinImport.found")(function* (originKey: string) {
      const [row] = yield* sql<Found>`SELECT record_id AS "recordId", key FROM kin_records
        WHERE org_id = ${orgId} AND origin_key = ${originKey} ORDER BY record_id`;
      return row;
    });
    const changed: Array<{ source: string; key: string }> = [];
    /** Made by an earlier run; `edited` when anyone but an import has changed it since. */
    const existing = Effect.fn("KinImport.existing")(function* (
      section: "clients" | "projects" | "entries",
      source: string,
      tally: boolean,
    ) {
      const row = yield* found(originOf(SINGULAR[section], source));
      if (row === undefined) return undefined;
      const others = yield* sql`SELECT 1 FROM kin_record_changes
        WHERE org_id = ${orgId} AND record_id = ${row.recordId} AND via <> 'import' LIMIT 1`;
      const edited = others.length > 0;
      if (tally) {
        counts[section][edited ? "changed" : "unchanged"] += 1;
        if (edited) changed.push({ source, key: row.key });
      }
      return { ...row, edited };
    });

    // Lists are made or added to, never narrowed; a plan makes them again in every chunk.
    const listReport: Array<KinImportReport["lists"][number]> = [];
    const failedLists = new Set<string>();
    const defs = new Map<string, ListDef>();
    const listStep = Effect.fn("KinImport.list")(function* (spec: KinImportList) {
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
      const fields: Array<NonNullable<KinImportList["fields"]>[number]> = [];
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
              return Effect.succeed(tally ? problem("lists", spec.list, error.message) : undefined);
            },
          }),
        );
        if (tally && outcome !== undefined) listReport.push(outcome);
      }
      // A plan's lists are gone once its chunk rolls back; the files after it read them here.
      if (tally)
        for (const spec of doc.lists ?? []) {
          const def = yield* listDef(orgId, spec.list);
          if (def !== undefined) defs.set(spec.list, def);
        }
    });

    // Company details fill only what Kin has none of; bank details stay the owner's to set.
    const companyReport: Array<KinImportReport["company"][number]> = [];
    if (doc.company !== undefined) {
      const current = yield* readProfile(orgId);
      const fill: { -readonly [K in (typeof COMPANY_FIELDS)[number]]?: string } = {};
      for (const field of COMPANY_FIELDS) {
        const value = doc.company[field];
        if (value === undefined || value === null) continue;
        const action =
          current[field] === null ? "fill" : current[field] === value ? "same" : "differs";
        if (action === "fill") fill[field] = value;
        companyReport.push({ field, action });
      }
      if (
        Object.values(doc.company.bank ?? {}).some((value) => value !== undefined && value !== null)
      )
        companyReport.push({ field: "bank", action: "not_imported" });
      const patch: ProfilePatch = fill;
      if (keep && Object.keys(patch).length > 0)
        yield* setProfile(orgId, { _tag: "person", personId: owner }, patch, undefined);
    }

    const failed = {
      clients: new Set<string>(),
      projects: new Set<string>(),
      entries: new Set<string>(),
    };
    /** One row in its own savepoint: a refusal undoes only it and becomes its problem line. */
    const row = <A, R>(
      section: KinImportSection,
      source: string,
      effect: Effect.Effect<A, Failure, R>,
      onFail?: () => void,
    ) =>
      sql.withTransaction(effect).pipe(
        Effect.catchTags({
          KinChatError: (error) => {
            onFail?.();
            return Effect.succeed(problem(section, source, error.message));
          },
        }),
      );
    const dates = (createdAt: string | undefined, closedAt: string | undefined) => ({
      ...(createdAt === undefined ? {} : { createdAt: at(createdAt) }),
      ...(closedAt === undefined ? {} : { closedAt: at(closedAt, true) }),
    });

    /** A client's record id, made if need be; `tally` only where its own section counts it. */
    const client = Effect.fn("KinImport.client")(function* (source: string, tally: boolean) {
      const spec = clients.get(source);
      if (spec === undefined) return (yield* found(originOf("client", source)))?.recordId;
      if (failed.clients.has(source)) return undefined;
      const had = yield* existing("clients", source, tally);
      if (had !== undefined) return had.recordId;
      const [same] = yield* sql<Found>`SELECT record_id AS "recordId", key FROM kin_records
        WHERE org_id = ${orgId} AND register_id = 'clients' AND state NOT IN ${sql.in(CLOSED)}
          AND lower(title) = lower(${spec.name}) ORDER BY key LIMIT 1`;
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
        "clients",
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
        () => failed.clients.add(source),
      );
      if (created === undefined) return undefined;
      if (tally) counts.clients.create += 1;
      return created.row.recordId;
    });

    const project = Effect.fn("KinImport.project")(function* (source: string, tally: boolean) {
      const spec = projects.get(source);
      if (spec === undefined) return (yield* found(originOf("project", source)))?.recordId;
      if (failed.projects.has(source)) return undefined;
      const had = yield* existing("projects", source, tally);
      if (had !== undefined) return had.recordId;
      const partyId = spec.client === undefined ? null : yield* client(spec.client, false);
      if (partyId === undefined) {
        failed.projects.add(source);
        return problem(
          "projects",
          source,
          `Its client ${spec.client} isn't here or couldn't be imported.`,
        );
      }
      const created = yield* row(
        "projects",
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
        () => failed.projects.add(source),
      );
      if (created === undefined) return undefined;
      if (tally) counts.projects.create += 1;
      return created.row.recordId;
    });

    /** A field's value as Kin stores it, with what it points at resolved in this org. */
    const fieldValue = Effect.fn("KinImport.fieldValue")(function* (
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
        return yield* invalid(`${spec.label} takes files from the files section.`);
      if (spec?.type === "person") {
        if (value !== "owner") return yield* invalid(`${spec.label} takes "owner".`);
        return `person:${owner}`;
      }
      if (spec?.type === "link") {
        const projectLink = spec.link === "projects";
        const id = projectLink ? yield* project(value, false) : yield* client(value, false);
        if (id === undefined || id === null)
          return yield* invalid(
            `${spec.label}: no ${projectLink ? "project" : "client"} ${value} here.`,
          );
        return id;
      }
      return value;
    });

    const targets = new Map<string, Target>();
    const paidFor = new Map<string, bigint>();
    const pay = Effect.fn("KinImport.pay")(function* (
      key: string,
      payment: KinImportPayment,
      currency: string,
    ) {
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
      paidFor.set(payment.entry, (paidFor.get(payment.entry) ?? 0n) + BigInt(amount.money.minor));
    });
    const payAll = Effect.fn("KinImport.payAll")(function* (
      due: ReadonlyArray<KinImportPayment>,
      key: string,
      currency: string,
    ) {
      for (const payment of due)
        yield* row("payments", payment.source, pay(key, payment, currency));
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
    /** What the owner compares with the old system: every entry of the file that came in. */
    const tally = (spec: KinImportEntry, def: ListDef, amount: KinMoney | undefined) => {
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
        sum.paid += paidFor.get(spec.source) ?? 0n;
        money.set(slot, sum);
      }
    };
    const isOpen = (spec: KinImportEntry, def: ListDef, amount: KinMoney | undefined) => {
      if (CLOSED.includes(spec.state ?? def.defaultState)) return false;
      const due = byEntry.get(spec.source) ?? [];
      if (amount === undefined || due.length === 0) return true;
      const paid = due.reduce((sum, one) => {
        const money = parseAmount(one.amount, one.currency ?? amount.currency);
        return sum + ("money" in money ? BigInt(money.money.minor) : 0n);
      }, 0n);
      return paid !== BigInt(amount.minor);
    };
    const staleOne = (spec: KinImportEntry, def: ListDef) => {
      if (doc.asOf === undefined) return;
      const last = dayOf(spec.date) ?? dayOf(spec.createdAt) ?? dayOf(spec.due);
      if (last !== undefined && last >= doc.asOf) return;
      const one = stale.get(def.id) ?? { open: 0, oldest: null };
      one.open += 1;
      if (last !== undefined && (one.oldest === null || last < one.oldest)) one.oldest = last;
      stale.set(def.id, one);
    };

    const entry = Effect.fn("KinImport.entry")(function* (spec: KinImportEntry) {
      const due = byEntry.get(spec.source) ?? [];
      const fail = (reason: string) => {
        failed.entries.add(spec.source);
        for (const payment of due)
          problem("payments", payment.source, `Its entry ${spec.source} couldn't be imported.`);
        return problem("entries", spec.source, reason);
      };
      if (failedLists.has(spec.list)) return fail(`Its list ${spec.list} couldn't be made.`);
      const def = yield* listDef(orgId, spec.list);
      if (def === undefined) return fail(`There is no list ${spec.list}; define it in lists.`);
      const currency = spec.currency ?? def.currency;
      const parsed = spec.amount === undefined ? undefined : parseAmount(spec.amount, currency);
      if (parsed !== undefined && "error" in parsed) return fail(parsed.error.message);
      const amount = parsed?.money;
      const open = isOpen(spec, def, amount);
      const had = yield* existing("entries", spec.source, true);
      if (had !== undefined) {
        const stored = yield* records.getById(orgId, had.recordId);
        targets.set(spec.source, {
          list: def.id,
          key: had.key,
          edited: had.edited,
          fields: parseFields(stored?.fieldsJson ?? "{}"),
        });
        if (had.edited) counts.payments.changed += due.length;
        else yield* payAll(due, had.key, stored?.currency ?? currency);
        tally(spec, def, amount);
        if (open) staleOne(spec, def);
        return;
      }
      const partyId = spec.client === undefined ? undefined : yield* client(spec.client, false);
      if (spec.client !== undefined && partyId === undefined)
        return fail(`Its client ${spec.client} isn't here or couldn't be imported.`);
      const projectId =
        spec.project === undefined ? undefined : yield* project(spec.project, false);
      if (spec.project !== undefined && (projectId === undefined || projectId === null))
        return fail(`Its project ${spec.project} isn't here or couldn't be imported.`);
      const state = spec.state ?? def.defaultState;
      const notes = [
        spec.notes ?? "",
        open && doc.asOf !== undefined
          ? `Imported from ${doc.source ?? doc.batch} on ${today}. Those records were last kept up on ${doc.asOf}, so check this is still current.`
          : "",
      ]
        .filter((part) => part !== "")
        .join("\n\n");
      const made = yield* row(
        "entries",
        spec.source,
        Effect.gen(function* () {
          const fields: Record<string, FieldValue> = {};
          for (const [key, value] of Object.entries(spec.fields ?? {}))
            fields[key] = yield* fieldValue(def, key, value);
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
            state,
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
          yield* payAll(due, record.key, record.currency ?? currency);
          return { fields, key: record.key };
        }),
        () => {
          failed.entries.add(spec.source);
          for (const payment of due)
            problem("payments", payment.source, `Its entry ${spec.source} couldn't be imported.`);
        },
      );
      if (made === undefined) return;
      counts.entries.create += 1;
      // A plan's entry is rolled back with its chunk: its files are only checked.
      targets.set(spec.source, {
        list: def.id,
        key: keep ? made.key : undefined,
        edited: false,
        fields: made.fields,
      });
      tally(spec, def, amount);
      if (open) staleOne(spec, def);
    });

    /** An entry an earlier file of this batch made, for payments and files that name it. */
    const earlier = Effect.fn("KinImport.earlier")(function* (source: string) {
      const had = yield* existing("entries", source, false);
      if (had === undefined) return undefined;
      const stored = yield* records.getById(orgId, had.recordId);
      if (stored === undefined) return undefined;
      const target: Target = {
        list: stored.registerId,
        key: had.key,
        edited: had.edited,
        fields: parseFields(stored.fieldsJson),
      };
      targets.set(source, target);
      return { target, currency: stored.currency };
    });
    const latePayments = Effect.fn("KinImport.latePayments")(function* (source: string) {
      const due = byEntry.get(source) ?? [];
      const had = yield* earlier(source);
      if (had === undefined) {
        for (const payment of due)
          problem(
            "payments",
            payment.source,
            `There is no entry ${source} here or imported before.`,
          );
        return;
      }
      if (had.target.edited) counts.payments.changed += due.length;
      else if (had.target.key !== undefined)
        yield* payAll(due, had.target.key, had.currency ?? "INR");
    });

    // One transaction per chunk, each rolled back in a plan; a plan's chunk makes the lists
    // again first, and its rows make the clients and projects they point at, so all resolve.
    const inChunks = <A, R>(
      items: ReadonlyArray<A>,
      each: (item: A) => Effect.Effect<unknown, Failure, R>,
    ) =>
      Effect.forEach(
        Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, index) =>
          items.slice(index * CHUNK, (index + 1) * CHUNK),
        ),
        (chunk) => {
          const work = Effect.gen(function* () {
            if (!keep) yield* defineLists(false);
            for (const item of chunk) yield* each(item);
          });
          return keep ? sql.withTransaction(work) : rolledBack(work);
        },
        { discard: true },
      );
    const rolledBack = <A, R>(work: Effect.Effect<A, Failure, R>) =>
      sql
        .withTransaction(work.pipe(Effect.andThen(Effect.fail(new Rollback()))))
        .pipe(Effect.catchTags({ KinImportRollback: () => Effect.void }));

    yield* keep ? defineLists(true) : rolledBack(defineLists(true));
    yield* inChunks([...clients.keys()], (source) => client(source, true));
    yield* inChunks([...projects.keys()], (source) => project(source, true));
    yield* inChunks([...entries.values()], entry);
    yield* inChunks(
      [...byEntry.keys()].filter((source) => !entries.has(source)),
      latePayments,
    );

    // Files last: each read and checked outside any transaction, then kept on its entry.
    const onField = new Map<string, number>();
    for (const spec of files.values()) {
      const target =
        targets.get(spec.entry) ??
        (entries.has(spec.entry) ? undefined : (yield* earlier(spec.entry))?.target);
      if (target === undefined) {
        problem(
          "files",
          spec.source,
          entries.has(spec.entry)
            ? `Its entry ${spec.entry} couldn't be imported.`
            : `There is no entry ${spec.entry} here or imported before.`,
        );
        continue;
      }
      if (target.edited) {
        counts.files.changed += 1;
        continue;
      }
      const originKey = originOf("file", spec.source);
      const kept = yield* sql`SELECT 1 FROM kin_entry_files
        WHERE org_id = ${orgId} AND origin_key = ${originKey} LIMIT 1`;
      if (kept.length > 0) {
        counts.files.unchanged += 1;
        continue;
      }
      const def = defs.get(target.list) ?? (yield* listDef(orgId, target.list));
      const key =
        spec.field ?? def?.fields.find((one) => one.type === "file" && one.retired !== true)?.key;
      const field = def?.fields.find((one) => one.key === key && one.type === "file");
      if (field === undefined) {
        problem(
          "files",
          spec.source,
          `${def?.name ?? target.list} has no file field ${spec.field ?? ""}`.trim() + ".",
        );
        continue;
      }
      const type = keptType(spec.name);
      if (type === undefined) {
        problem("files", spec.source, `Kin keeps ${KEPT_TYPES} files, and this isn't one.`);
        continue;
      }
      const slot = `${spec.entry}|${field.key}`;
      const stored = target.fields[field.key];
      const held = onField.get(slot) ?? (Array.isArray(stored) ? stored.length : 0);
      if (held >= MAX_FILES_PER_FIELD) {
        problem("files", spec.source, `${field.label} holds at most ${MAX_FILES_PER_FIELD} files.`);
        continue;
      }
      const shown = `files/${spec.path.slice(0, 200)}`;
      const read = yield* bundle.read(spec.path);
      if ("missing" in read) {
        problem("files", spec.source, `${shown} isn't in the import.`);
        continue;
      }
      if ("refused" in read) {
        problem("files", spec.source, `${shown} can't be imported: ${read.refused}.`);
        continue;
      }
      const sha256 = NodeCrypto.createHash("sha256").update(read.bytes).digest("hex");
      if (sha256 !== spec.sha256) {
        problem("files", spec.source, `${shown} doesn't match its sha256.`);
        continue;
      }
      const wrong = yield* Effect.promise(() => typeMismatch(type.extension, read.bytes));
      if (wrong !== undefined) {
        problem("files", spec.source, `${shown} can't be imported: ${wrong}.`);
        continue;
      }
      onField.set(slot, held + 1);
      const entryKey = target.key;
      if (!keep || entryKey === undefined) {
        counts.files.create += 1;
        continue;
      }
      const attachmentId = yield* platform(
        keepOrgFile(orgId, doc.batch, { sha256, extension: type.extension, bytes: read.bytes }),
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (attachmentId === undefined) {
        problem("files", spec.source, `Kin couldn't keep ${shown}.`);
        continue;
      }
      const attached = yield* row(
        "files",
        spec.source,
        Effect.gen(function* () {
          const current = yield* records.get(orgId, entryKey);
          if (current === undefined) return yield* invalid(`Its entry ${spec.entry} is gone.`);
          yield* sql`INSERT INTO kin_entry_files (org_id, origin_key, record_id, attachment_id,
              name, mime_type, size_bytes, sha256, created_at)
            VALUES (${orgId}, ${originKey}, ${current.recordId}, ${attachmentId}, ${spec.name},
              ${type.mimeType}, ${read.bytes.byteLength}, ${sha256}, ${now})
            ON CONFLICT DO NOTHING`;
          const ids = parseFields(current.fieldsJson)[field.key];
          const list = Array.isArray(ids) ? ids : [];
          if (!list.includes(attachmentId))
            yield* records.update(orgId, writer, entryKey, {
              fields: { [field.key]: [...list, attachmentId] },
            });
          return true;
        }),
      );
      if (attached !== undefined) counts.files.create += 1;
    }

    const asMoney = (minor: bigint, currency: string): KinMoney => ({
      minor: Number(minor),
      currency,
    });
    const byName = <A>(rows: Iterable<readonly [string, A]>) =>
      [...rows].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      batch: doc.batch,
      asOf: doc.asOf ?? null,
      applied: keep,
      lists: listReport,
      company: companyReport,
      ...counts,
      changed: changed.map((one) => ({ source: one.source, key: KinRecordKey.make(one.key) })),
      money: byName(money).map(([, one]) => ({
        list: one.list,
        entries: one.entries,
        total: asMoney(one.total, one.currency),
        paid: asMoney(one.paid, one.currency),
      })),
      stale: byName(stale).map(([list, one]) => ({ list, ...one })),
      problems,
      moreProblems,
    } satisfies KinImportReport;
  }, workFailure);

  return KinImport.of({
    plan: Effect.fn("KinImport.plan")(function* (orgId, owner, bundle) {
      return yield* run(orgId, owner, bundle, false).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    }),
    apply: Effect.fn("KinImport.apply")(function* (orgId, owner, bundle) {
      return yield* run(orgId, owner, bundle, true).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    }),
    fromUpload: Effect.fn("KinImport.fromUpload")(function* (uploader, attachmentId) {
      const gone = new KinChatError({
        reason: "not_found",
        message: "That upload isn't here any more; upload the file again.",
      });
      const mine = yield* platform(ownsPendingUpload(attachmentId, uploader));
      const file = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId,
      });
      if (!mine || file === null) return yield* gone;
      const bytes = yield* fs.readFile(file).pipe(Effect.mapError(() => gone));
      return yield* zipBundle(bytes);
    }),
    fromHost: Effect.fn("KinImport.fromHost")(function* (target) {
      return yield* platform(hostBundle(target));
    }),
  });
});

export const layer = Layer.effect(KinImport, make);

/** The owner's plan or apply of a ZIP they uploaded; the same upload serves both. */
export const ownerImport = Effect.fn("KinImport.owner")(function* (
  people: ReadonlyArray<PersonIdentity>,
  uploader: PendingUploadOwner,
  input: KinImportInput,
  keep: boolean,
) {
  const person = yield* theOwner(people, input.orgId);
  const imports = yield* KinImport;
  const bundle = yield* imports.fromUpload(uploader, input.upload);
  return yield* (keep ? imports.apply : imports.plan)(input.orgId, person.personId, bundle);
}, workFailure);
