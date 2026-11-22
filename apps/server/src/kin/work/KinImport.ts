import {
  KinChatError,
  type KinMoney,
  type KinNumberingRule,
  type KinOrgId,
  KinPersonId,
  type KinRecordState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import { IMPORTED_SERIES, ruleProblem, seriesOf } from "../gendocs/numbering.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { sectionOn } from "../shell/KinShell.ts";
import { DEALS_OFF } from "../shell/sections.ts";
import { contactAll, contactFields } from "./contactDetails.ts";
import { createAs } from "./deals.ts";
import {
  ImportHeader,
  type ImportContact,
  type ImportDeal,
  type ImportEntry,
  type ImportList,
  type ImportPayment,
  ImportRow,
  type ImportClient,
  type ImportProject,
} from "./importFormat.ts";
import { type CreateInput, KinRecords, type PlainImportInput, type Writer } from "./KinRecords.ts";
import { type FieldValue, fieldList, fieldText, parseFields } from "./lists.ts";
import { dayIn, farAbove, issuedAfterDue, largestIn, parseAmount } from "./money.ts";
import { companyMoneyState } from "./companyProfile.ts";
import {
  byKey,
  endOfDay,
  ownerZone,
  type RecordRow,
  startOfDay,
  workFailure,
} from "./recordRows.ts";
import { regionOf } from "./region.ts";
import {
  defineList,
  keyFor,
  type ListDef,
  listDef,
  numberingOf,
  type Proposal,
  proposalFor,
  startState,
  storedCategoryLabels,
} from "./registers.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { IMPORT_BUSY, notImporting, undoBatch, type UndoReport } from "./importUndo.ts";

// Everything an import makes is keyed `import:<batch>:<kind>:<source>`, so a rerun makes nothing
// twice and leaves alone what someone changed since. Rows go a hundred to a transaction: a crash
// leaves whole chunks a rerun completes. A plan runs the same chunks and rolls each one back.

const CHUNK = 100;
const MAX_ROWS = 200_000;
const MAX_LINE_CHARS = 1_000_000;
const MAX_FILE_BYTES = 1_000_000_000;
const MAX_LISTED = 2_000;
const CLOSED: ReadonlyArray<KinRecordState> = ["done", "dropped"];
const NOT_ENTRIES = ["clients", "projects", "docs"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const isKinError = Schema.is(KinChatError);
const COUNTRY_FIRST =
  "This row has money, and Kin records none until the company's country is chosen in Settings, Company details. Import the file again once it is.";
/** Whether a row puts money on its entry: an amount, a payment, or an amount in a field. */
const withMoney = (spec: ImportEntry, def: ListDef) =>
  spec.amount !== undefined ||
  (spec.payments ?? []).length > 0 ||
  Object.entries(spec.fields ?? {}).some(
    ([key, value]) =>
      typeof value !== "string" ||
      def.fields.some((one) => one.key === key && one.type === "money"),
  );
const decodeHeader = Schema.decodeUnknownEffect(Schema.fromJsonString(ImportHeader));
const decodeRow = Schema.decodeUnknownEffect(Schema.fromJsonString(ImportRow));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
class Rollback extends Schema.TaggedError<Rollback>()("KinImportRollback", {}) {}
type Failure = KinChatError | SqlError.SqlError | Schema.SchemaError;
type Decoded =
  | { readonly line: number; readonly row: ImportRow }
  | { readonly line: number; readonly row: undefined; readonly failure: string };
type Named = { readonly recordId: string; readonly key: string; readonly gstin: unknown };

type Counts = {
  create: number;
  unchanged: number;
  matched: number;
  changed: number;
  problems: number;
};
const zero = (): Counts => ({ create: 0, unchanged: 0, matched: 0, changed: 0, problems: 0 });
type Kind = "client" | "project" | "entry" | "payment" | "contact" | "deal";
/** A field an import filled on a record Kin had, empty before; undo empties it again at `rev`. */
export type ImportFill = {
  readonly recordId: string;
  readonly key: string;
  readonly rev: number;
  readonly fields: ReadonlyArray<string>;
};
const NO_DEALS_HERE =
  "Deals come in through Clients, Add, Import a file, where Kin knows who imports them.";
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
  readonly contacts: Counts;
  readonly deals: Counts;
  /** Fields filled on clients and contacts Kin had, which had none. */
  readonly filled: number;
  /** Of the clients made, how many as prospects. */
  readonly prospects: number;
  /** Imported before and changed in Kin since: left as they are, with their payments. */
  readonly changed: ReadonlyArray<{ readonly source: string; readonly key: string }>;
  /** What the company's country calls a tax id, which a client's `gstin` holds: GSTIN in India. */
  readonly taxIdLabel: string;
  /**
   * Clients of the file named like one already in Kin: matched to `key`, or, when both have a
   * tax id and they differ, made as a new client `made` instead.
   */
  readonly clientMatches: ReadonlyArray<{
    readonly source: string;
    readonly name: string;
    readonly key: string;
    readonly made: string | null;
  }>;
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
export type RunOptions = {
  readonly progress?: Progress | undefined;
  /** Checked in the transaction that starts the run: who may import, from stored rows. */
  readonly guard?: Effect.Effect<void, KinChatError, SqlClient.SqlClient> | undefined;
  /** The file's name, kept with the run for the list of earlier imports. */
  readonly file?: string | undefined;
};

export class KinImport extends Context.Service<
  KinImport,
  {
    /** What `apply` would do, with nothing kept. */
    readonly plan: (
      orgId: KinOrgId,
      owner: KinPersonId,
      lines: Lines,
      options?: RunOptions,
    ) => Effect.Effect<ImportReport, KinChatError>;
    readonly apply: (
      orgId: KinOrgId,
      owner: KinPersonId,
      lines: Lines,
      options?: RunOptions,
    ) => Effect.Effect<ImportReport, KinChatError>;
    /** Takes a batch away: what it made that nobody changed or uses since. */
    readonly undo: (
      orgId: KinOrgId,
      owner: KinPersonId,
      batch: string,
      options: { readonly apply: boolean; readonly includeChanged: boolean },
    ) => Effect.Effect<UndoReport, KinChatError>;
    readonly fromFile: (path: string) => Lines;
    /** The checks, imports and undos this host is running for the org, oldest first. */
    readonly running: (orgId: KinOrgId) => Effect.Effect<ReadonlyArray<ImportLive>>;
  }
>()("t3/kin/work/KinImport") {}

/** A run going on in this host; an import's and an undo's own row is `seq` in `kin_import_runs`. */
export type ImportLive = {
  readonly action: "check" | "apply" | "undo";
  readonly personId: KinPersonId;
  readonly startedAt: number;
  batch: string;
  file: string | null;
  seq: number | null;
  done: number;
  of: number;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const refreshes = yield* KinRefreshObserver;
  const fs = yield* FileSystem.FileSystem;
  // The command line has no session: deals, whose rules are a person's, come in from the screen.
  const identity = yield* Effect.serviceOption(KinIdentity);
  const scope = yield* Scope.Scope;
  const live = new Map<KinOrgId, Set<ImportLive>>();

  /**
   * Runs `work` as `entry`, seen by `running` until it ends. An import or undo is refused while
   * another runs for the org, and runs on in the host's own scope: a caller that goes away, as a
   * dropped connection does, stops waiting for it but not it.
   */
  const tracked = Effect.fn("KinImport.tracked")(function* <A>(
    orgId: KinOrgId,
    entry: ImportLive,
    work: (entry: ImportLive) => Effect.Effect<A, KinChatError>,
  ) {
    const held = live.get(orgId) ?? new Set<ImportLive>();
    const writes = entry.action !== "check";
    if (writes && [...held].some((one) => one.action !== "check"))
      return yield* new KinChatError({ reason: "conflict", message: IMPORT_BUSY });
    held.add(entry);
    live.set(orgId, held);
    const body = work(entry).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          held.delete(entry);
          if (held.size === 0 && live.get(orgId) === held) live.delete(orgId);
          // One that stopped part way holds nothing: running it again may start at once.
          const letGo =
            entry.seq === null
              ? Effect.void
              : sql`UPDATE kin_import_runs SET summary_json = json_remove(summary_json, '$.beat')
                  WHERE seq = ${entry.seq} AND finished_at IS NULL`.pipe(Effect.ignore);
          return Effect.andThen(letGo, refreshes.touch(orgId, "imports"));
        }),
      ),
    );
    if (!writes) return yield* body;
    return yield* Fiber.join(yield* Effect.forkIn(body, scope));
  });

  const run = Effect.fn("KinImport.run")(function* (
    orgId: KinOrgId,
    owner: KinPersonId,
    lines: Lines,
    keep: boolean,
    options: RunOptions,
    watched: ImportLive,
  ) {
    const { progress } = options;
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
    watched.batch = doc.batch;
    watched.file = options.file ?? null;
    watched.of = scan.rows;

    const problems: Array<ImportProblem> = [];
    let more = 0;
    const counts = {
      clients: zero(),
      projects: zero(),
      entries: zero(),
      payments: zero(),
      contacts: zero(),
      deals: zero(),
    };
    const SECTION = {
      client: "clients",
      project: "projects",
      entry: "entries",
      payment: "payments",
      contact: "contacts",
      deal: "deals",
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
    // One read for the file: it also spares each money row its own country check.
    const company = yield* companyMoneyState(orgId);
    const home = company.homeCurrency;
    // Each list's largest amount per currency, read once and raised as the file goes.
    const largest = new Map<string, bigint>();
    const slip = Effect.fn("KinImport.slip")(function* (
      spec: ImportEntry,
      def: ListDef,
      amount: KinMoney | undefined,
      pending = largest,
    ) {
      if (spec.confirmed === true) return undefined;
      if (amount !== undefined && amount.minor >= 0) {
        const slot = `${def.id}|${amount.currency}`;
        const most =
          pending.get(slot) ??
          largest.get(slot) ??
          (yield* largestIn(orgId, def.id, amount.currency));
        const far = farAbove(def.name, amount, most, home);
        if (far !== undefined) return far;
        const size = BigInt(amount.minor);
        pending.set(slot, size > most ? size : most);
      }
      return def.id === "invoices" && spec.date !== undefined && spec.due !== undefined
        ? issuedAfterDue(at(spec.date, true), at(spec.due, true), zone)
        : undefined;
    });

    // What this chunk's rows point at, read once per chunk inside its transaction and forgotten
    // when it ends: a plan's chunk is rolled back, and a later chunk reads afresh.
    const memo = {
      found: new Map<string, { recordId: string; key: string } | undefined>(),
      edited: new Set<string>(),
      /** By `lower(title)`: the first open client by key, as the one-name read below finds it. */
      named: new Map<string, Named | undefined>(),
      /** Names as SQLite's `lower` writes them, so the two never disagree. */
      lowered: new Map<string, string>(),
      people: new Map<string, string | undefined>(),
    };
    const forget = () => {
      memo.found.clear();
      memo.edited.clear();
      memo.named.clear();
      memo.lowered.clear();
      memo.people.clear();
    };
    /** An open client named `name` but for case, first by key. */
    const sameNamed = Effect.fn("KinImport.sameNamed")(function* (name: string) {
      const lower = memo.lowered.get(name);
      if (lower !== undefined && memo.named.has(lower)) return memo.named.get(lower);
      const [same] = yield* sql<Named>`SELECT
          record_id AS "recordId", key, json_extract(fields_json, '$.gstin') AS gstin
        FROM kin_records WHERE org_id = ${orgId} AND register_id = 'clients'
          AND state NOT IN ${sql.in(CLOSED)} AND lower(title) = lower(${name})
          ORDER BY +key LIMIT 1`;
      return same;
    });
    /** A client this chunk made, which the one-name read would find from now on. */
    const namedNow = (row: RecordRow) => {
      if (CLOSED.includes(row.state)) return;
      const lower = memo.lowered.get(row.title);
      // A title not lowered ahead: every name is read again rather than guessed.
      if (lower === undefined) return memo.named.clear();
      if (!memo.named.has(lower)) return;
      const held = memo.named.get(lower);
      if (held === undefined || row.key < held.key)
        memo.named.set(lower, {
          recordId: row.recordId,
          key: row.key,
          gstin: parseFields(row.fieldsJson).gstin ?? null,
        });
    };
    const found = Effect.fn("KinImport.found")(function* (originKey: string) {
      if (memo.found.has(originKey)) return memo.found.get(originKey);
      const [row] = yield* sql<{ recordId: string; key: string }>`SELECT record_id AS "recordId",
          key FROM kin_records WHERE org_id = ${orgId} AND origin_key = ${originKey}`;
      if (row !== undefined) {
        const others = yield* sql`SELECT 1 FROM kin_record_changes
          WHERE org_id = ${orgId} AND record_id = ${row.recordId} AND via <> 'import' LIMIT 1`;
        if (others.length > 0) memo.edited.add(row.recordId);
      }
      memo.found.set(originKey, row);
      return row;
    });
    const made = (originKey: string, row: { readonly recordId: string; readonly key: string }) => {
      memo.found.set(originKey, { recordId: row.recordId, key: row.key });
    };
    const changed: Array<{ source: string; key: string }> = [];
    const clientMatches: Array<ImportReport["clientMatches"][number]> = [];
    const matchedClient = (match: ImportReport["clientMatches"][number]) => {
      if (clientMatches.length < MAX_LISTED) clientMatches.push(match);
      else more += 1;
    };
    /** Made by an earlier run; `edited` when anyone but an import has changed it since. */
    const existing = Effect.fn("KinImport.existing")(function* (
      kind: "client" | "project" | "entry" | "contact" | "deal",
      source: string,
      tally: boolean,
    ) {
      const row = yield* found(originOf(kind, source));
      if (row === undefined) return undefined;
      const edited = memo.edited.has(row.recordId);
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
    const seen = {
      entry: new Set<string>(),
      payment: new Set<string>(),
      contact: new Set<string>(),
      deal: new Set<string>(),
    };
    const failed = { client: new Set<string>(), project: new Set<string>() };
    const fills: Array<ImportFill> = [];
    let prospects = 0;
    let fillsWritten = 0;
    /** A person on the team by id, else whoever imports. */
    const lookerAfter = Effect.fn("KinImport.lookerAfter")(function* (
      personId: string | undefined,
    ) {
      if (personId === undefined || personId === owner) return me;
      if (!memo.people.has(personId)) {
        const [person] = yield* sql<{ id: string }>`SELECT person_id AS id FROM kin_people
          WHERE org_id = ${orgId} AND person_id = ${personId} AND removed_at IS NULL`;
        memo.people.set(personId, person?.id);
      }
      const id = memo.people.get(personId);
      return id === undefined ? me : { _tag: "person" as const, personId: KinPersonId.make(id) };
    });
    /** Fills on `key` only what it lacks; a field it has stays as someone typed it. */
    const fill = Effect.fn("KinImport.fill")(function* (
      key: string,
      list: "clients" | "contacts",
      given: { readonly notes?: string | undefined; readonly fields: Record<string, FieldValue> },
    ) {
      const had = yield* byKey(orgId, key);
      if (had === undefined || had.registerId !== list)
        return yield* invalid(`There is no ${list === "clients" ? "client" : "contact"} ${key}.`);
      const stored = parseFields(had.fieldsJson);
      const fields: Record<string, FieldValue | null> = {};
      const named: Array<string> = [];
      for (const [field, value] of Object.entries(given.fields)) {
        if (field === "emails" || field === "phones") {
          const kind = field === "emails" ? "email" : "phone";
          if (contactAll(stored, kind).length > 0 || !Array.isArray(value)) continue;
          const made = contactFields(stored, { [field]: value });
          if (isKinError(made)) return yield* made;
          Object.assign(fields, made);
          named.push(kind);
          continue;
        }
        const stays = Array.isArray(value)
          ? fieldList(stored, field).length > 0
          : fieldText(stored, field) !== null;
        if (stays) continue;
        fields[field] = value;
        named.push(field);
      }
      const notes = given.notes !== undefined && had.notes.trim() === "" ? given.notes : undefined;
      if (notes !== undefined) named.push("notes");
      if (named.length === 0) return had;
      const after = yield* records.update(orgId, writer, key, {
        ...(Object.keys(fields).length === 0 ? {} : { fields }),
        ...(notes === undefined ? {} : { notes }),
      });
      fills.push({ recordId: after.recordId, key: after.key, rev: after.rev, fields: named });
      return after;
    });
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
      const extra = {
        ...(spec.address === undefined ? {} : { address: spec.address }),
        ...(spec.cameFrom === undefined ? {} : { source: spec.cameFrom }),
        ...(spec.tags === undefined || spec.tags.length === 0 ? {} : { tags: [...spec.tags] }),
      };
      if (spec.match !== undefined) {
        const key = spec.match;
        const matched = yield* row(
          line,
          "client",
          source,
          fill(key, "clients", {
            ...(spec.notes === undefined ? {} : { notes: spec.notes }),
            fields: extra,
          }),
          () => failed.client.add(source),
        );
        if (matched === undefined) return undefined;
        if (tally) counts.clients.matched += 1;
        return matched.recordId;
      }
      const had = yield* existing("client", source, tally);
      if (had !== undefined) return had.recordId;
      const same = yield* sameNamed(spec.name);
      // Two tax ids that differ are two businesses, however alike their names.
      const differs =
        same !== undefined &&
        typeof same.gstin === "string" &&
        same.gstin !== "" &&
        spec.gstin !== undefined &&
        same.gstin.toUpperCase() !== spec.gstin.toUpperCase();
      if (same !== undefined && !differs) {
        if (tally) {
          counts.clients.matched += 1;
          matchedClient({ source, name: spec.name, key: same.key, made: null });
        }
        return same.recordId;
      }
      const fields: Record<string, FieldValue> = {
        ...Object.fromEntries(
          (["gstin", "terms", "placeOfSupply"] as const).flatMap((key) => {
            const value = spec[key];
            return value === undefined ? [] : [[key, value] as const];
          }),
        ),
        ...extra,
      };
      const lookedAfter = yield* lookerAfter(spec.owner);
      const created = yield* row(
        line,
        "client",
        source,
        records.create(orgId, writer, {
          list: "clients",
          originKey: originOf("client", source),
          title: differs ? `${spec.name} (${spec.gstin})` : spec.name,
          owner: lookedAfter,
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
      made(originOf("client", source), created.row);
      namedNow(created.row);
      if (tally) {
        counts.clients.create += 1;
        if (spec.kind === "prospect") prospects += 1;
        if (differs)
          matchedClient({ source, name: spec.name, key: same.key, made: created.row.key });
      }
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
      made(originOf("project", source), created.row);
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
            const before = yield* sql<{ voidedAt: number | null }>`SELECT voided_at AS "voidedAt"
              FROM kin_record_payments WHERE org_id = ${orgId} AND origin_key = ${originKey} LIMIT 1`;
            // A payment the owner voided since stays voided; importing again leaves it.
            if (before[0]?.voidedAt != null) {
              counts.payments.unchanged += 1;
              return;
            }
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
      const { series, seq } = seriesOf(rule, number, company.financialYearStartMonth);
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

    const amountOf = (spec: ImportEntry, def: ListDef) =>
      spec.amount === undefined
        ? undefined
        : parseAmount(spec.amount, spec.currency ?? def.currency, def.id === "expenses");

    const openFor = (
      spec: ImportEntry,
      def: ListDef,
      amount: KinMoney | undefined,
      due: ReadonlyArray<ImportPayment>,
    ) =>
      !CLOSED.includes(spec.state ?? def.defaultState) &&
      (amount === undefined ||
        due.length === 0 ||
        paidOf(due, amount.currency) !== BigInt(amount.minor));

    const entryInput = (
      spec: ImportEntry,
      def: ListDef,
      amount: KinMoney | undefined,
      open: boolean,
      due: ReadonlyArray<ImportPayment>,
    ): PlainImportInput => {
      const notes = [
        spec.notes ?? "",
        open && doc.asOf !== undefined
          ? `Imported from ${doc.source ?? doc.batch} on ${today}. Those records were last kept up on ${doc.asOf}, so check this is still current.`
          : "",
      ]
        .filter((part) => part !== "")
        .join("\n\n");
      const dateAt = spec.date === undefined ? undefined : at(spec.date, true);
      const createdAt = spec.createdAt === undefined ? undefined : at(spec.createdAt);
      return {
        originKey: originOf("entry", spec.source),
        title: spec.title,
        state:
          spec.state ??
          (def.id === "invoices" && due.length === 0
            ? startState(def, {
                dateAt: dateAt ?? null,
                numbered: spec.number !== undefined,
                now,
                zone,
              })
            : def.defaultState),
        ...(spec.category === undefined ? {} : { category: spec.category }),
        ...(spec.due === undefined
          ? {}
          : { dueAt: at(spec.due, true), dueAllDay: DAY.test(spec.due) }),
        ...(dateAt === undefined ? {} : { dateAt, dateAllDay: DAY.test(spec.date ?? "") }),
        ...(amount === undefined ? {} : { amount }),
        ...(notes === "" ? {} : { notes }),
        ...(spec.sensitive === undefined ? {} : { sensitive: spec.sensitive }),
        ...(createdAt === undefined ? {} : { createdAt }),
        closedAt:
          spec.closedAt === undefined ? (dateAt ?? createdAt ?? now) : at(spec.closedAt, true),
      };
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
      // Before any amount is read, so no line shows one in the placeholder currency.
      if (company.pending && withMoney(spec, def)) return fail(COUNTRY_FIRST);
      const currency = spec.currency ?? def.currency;
      const parsed = amountOf(spec, def);
      if (parsed !== undefined && "error" in parsed) return fail(parsed.error.message);
      const amount = parsed?.money;
      const open = openFor(spec, def, amount, due);
      const had = yield* existing("entry", spec.source, true);
      if (had !== undefined) {
        if (had.edited) counts.payments.changed += due.length;
        else yield* payAll(line, due, had.key, currency);
        return tally(spec, def, amount, open);
      }
      const slipped = yield* slip(spec, def, amount);
      if (slipped !== undefined) return fail(slipped);
      const partyId =
        spec.client === undefined ? undefined : yield* client(line, spec.client, false);
      if (spec.client !== undefined && partyId === undefined)
        return fail(`Its client ${spec.client} isn't above it or imported before.`);
      const projectId =
        spec.project === undefined ? undefined : yield* project(line, spec.project, false);
      if (spec.project !== undefined && (projectId === undefined || projectId === null))
        return fail(`Its project ${spec.project} isn't above it or imported before.`);
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
          const input: CreateInput = {
            ...entryInput(spec, def, amount, open, due),
            list: def.id,
            owner: me,
            ...(partyId === undefined ? {} : { partyId }),
            ...(projectId === undefined || projectId === null ? {} : { projectId }),
            fields,
          };
          const { row: record } = yield* records.create(orgId, writer, input);
          if (spec.number !== undefined && rule !== undefined)
            yield* keepNumber(
              def.id,
              record.recordId,
              spec.number,
              rule,
              input.dateAt ?? input.createdAt ?? now,
            );
          yield* payAll(line, due, record.key, record.currency ?? currency);
          // Lowered once its numbers and payments are in, as it was when they were recorded.
          if (spec.suggested === true)
            yield* records.update(orgId, writer, record.key, { confirmed: false });
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

    /** Its client's record id, or a problem line saying it isn't there. */
    const parentOf = Effect.fn("KinImport.parentOf")(function* (
      line: number,
      kind: "contact" | "deal",
      spec: ImportContact | ImportDeal,
    ) {
      const partyId = yield* client(line, spec.client, false);
      if (partyId === undefined)
        problem(
          line,
          kind,
          spec.source,
          `Its client ${spec.client} isn't above it or imported before.`,
        );
      return partyId;
    });

    const contact = Effect.fn("KinImport.contact")(function* (line: number, spec: ImportContact) {
      if (seen.contact.has(spec.source))
        return problem(line, "contact", spec.source, "Another contact has this source id.");
      seen.contact.add(spec.source);
      const given: Record<string, FieldValue> = {
        ...(spec.role === undefined ? {} : { role: spec.role }),
        ...(spec.emails === undefined || spec.emails.length === 0
          ? {}
          : { emails: [...spec.emails] }),
        ...(spec.phones === undefined || spec.phones.length === 0
          ? {}
          : { phones: [...spec.phones] }),
      };
      if (spec.match !== undefined) {
        const key = spec.match;
        const matched = yield* row(
          line,
          "contact",
          spec.source,
          fill(key, "contacts", {
            ...(spec.notes === undefined ? {} : { notes: spec.notes }),
            fields: given,
          }),
        );
        if (matched !== undefined) counts.contacts.matched += 1;
        return;
      }
      if ((yield* existing("contact", spec.source, true)) !== undefined) return;
      const partyId = yield* parentOf(line, "contact", spec);
      if (partyId === undefined) return;
      const made = yield* row(
        line,
        "contact",
        spec.source,
        Effect.gen(function* () {
          const details = contactFields({}, given);
          if (isKinError(details)) return yield* details;
          const fields = Object.fromEntries(
            Object.entries(details).flatMap(([key, value]) =>
              value === null ? [] : [[key, value] as const],
            ),
          );
          return yield* records.create(orgId, writer, {
            list: "contacts",
            originKey: originOf("contact", spec.source),
            title: spec.name,
            owner: me,
            partyId,
            ...(spec.notes === undefined ? {} : { notes: spec.notes }),
            fields,
          });
        }),
      );
      if (made !== undefined) counts.contacts.create += 1;
    });

    const deal = Effect.fn("KinImport.deal")(function* (line: number, spec: ImportDeal) {
      if (seen.deal.has(spec.source))
        return problem(line, "deal", spec.source, "Another deal has this source id.");
      seen.deal.add(spec.source);
      if ((yield* existing("deal", spec.source, true)) !== undefined) return;
      if (Option.isNone(identity)) return problem(line, "deal", spec.source, NO_DEALS_HERE);
      const partyId = yield* parentOf(line, "deal", spec);
      if (partyId === undefined) return;
      const value =
        spec.value === undefined ? undefined : parseAmount(spec.value.amount, spec.value.currency);
      if (value !== undefined && "error" in value)
        return problem(line, "deal", spec.source, value.error.message);
      const lookedAfter = yield* lookerAfter(spec.owner);
      const made = yield* row(
        line,
        "deal",
        spec.source,
        Effect.gen(function* () {
          const [party] = yield* sql<{ key: string }>`SELECT key FROM kin_records
            WHERE org_id = ${orgId} AND record_id = ${partyId}`;
          if (party === undefined) return yield* invalid("Its client isn't in Kin.");
          return yield* createAs(
            {
              orgId,
              writer: { ...writer, deal: true },
              members: [],
              person: owner,
            },
            {
              partyKey: party.key,
              title: spec.title,
              stage: spec.stage,
              ...(value === undefined ? {} : { value: value.money }),
              ...(spec.expected === undefined
                ? {}
                : { dueAt: endOfDay(spec.expected, zone), dueAllDay: true }),
              ...(spec.cameFrom === undefined ? {} : { source: spec.cameFrom }),
              ...(spec.notes === undefined ? {} : { notes: spec.notes }),
              owner: lookedAfter,
              originKey: originOf("deal", spec.source),
            },
          ).pipe(
            Effect.provideService(KinIdentity, identity.value),
            Effect.provideService(KinRecords, records),
          );
        }),
      );
      if (made !== undefined) counts.deals.create += 1;
    });

    const rowStep = Effect.fn("KinImport.row")(function* (decoded: Decoded, dealsOn: boolean) {
      const { line } = decoded;
      if (decoded.row === undefined)
        return problem(
          line,
          "file",
          null,
          `This line doesn't fit the format: ${decoded.failure.slice(0, 500)}`,
        );
      const one = decoded.row;
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
      if ("contact" in one) return yield* contact(line, one.contact);
      if ("deal" in one)
        return dealsOn
          ? yield* deal(line, one.deal)
          : problem(line, "deal", one.deal.source, DEALS_OFF);
      return yield* entry(line, one.entry);
    });

    /**
     * One read per kind for the chunk's rows, in its transaction: what they point at, whether
     * anyone changed it, and the clients their names already have. A row the chunk didn't name
     * ahead still reads alone, so nothing depends on this being complete.
     */
    const prefetch = Effect.fn("KinImport.prefetch")(function* (chunk: ReadonlyArray<Decoded>) {
      const origins = new Set<string>();
      const named: Array<ImportClient> = [];
      for (const { row: one } of chunk) {
        if (one === undefined) continue;
        if ("client" in one) {
          origins.add(originOf("client", one.client.source));
          if (one.client.match === undefined) named.push(one.client);
          continue;
        }
        const [kind, spec] =
          "project" in one
            ? (["project", one.project] as const)
            : "contact" in one
              ? (["contact", one.contact] as const)
              : "deal" in one
                ? (["deal", one.deal] as const)
                : (["entry", one.entry] as const);
        origins.add(originOf(kind, spec.source));
        if (spec.client !== undefined) origins.add(originOf("client", spec.client));
        if ("project" in spec && spec.project !== undefined)
          origins.add(originOf("project", spec.project));
      }
      const asked = [...origins].filter((origin) => !memo.found.has(origin));
      if (asked.length > 0) {
        const rows = yield* sql<{ recordId: string; key: string; origin: string }>`SELECT
            record_id AS "recordId", key, origin_key AS origin FROM kin_records
          WHERE org_id = ${orgId} AND origin_key IN ${sql.in(asked)} ORDER BY origin_key`;
        const byOrigin = new Map(rows.map((one) => [one.origin, one]));
        for (const origin of asked) {
          const one = byOrigin.get(origin);
          memo.found.set(
            origin,
            one === undefined ? undefined : { recordId: one.recordId, key: one.key },
          );
        }
        if (rows.length > 0) {
          const edited = yield* sql<{ id: string }>`SELECT DISTINCT record_id AS id
            FROM kin_record_changes WHERE org_id = ${orgId} AND via <> 'import'
              AND record_id IN ${sql.in(rows.map((one) => one.recordId))} ORDER BY record_id`;
          for (const one of edited) memo.edited.add(one.id);
        }
      }
      const names = named
        .filter((spec) => memo.found.get(originOf("client", spec.source)) === undefined)
        .flatMap((spec) =>
          spec.gstin === undefined ? [spec.name] : [spec.name, `${spec.name} (${spec.gstin})`],
        )
        .filter((name) => !memo.lowered.has(name));
      if (names.length === 0) return;
      const lowered = yield* sql<{ name: string; lower: string }>`SELECT value AS name,
          lower(value) AS lower FROM json_each(${encodeJson(names)}) ORDER BY key`;
      for (const one of lowered) memo.lowered.set(one.name, one.lower);
      const wanted = [...new Set(lowered.map((one) => one.lower))].filter(
        (lower) => !memo.named.has(lower),
      );
      if (wanted.length === 0) return;
      const same = yield* sql<Named & { lower: string }>`SELECT record_id AS "recordId", key,
          json_extract(fields_json, '$.gstin') AS gstin, lower(title) AS lower
        FROM kin_records WHERE org_id = ${orgId} AND register_id = 'clients'
          AND state NOT IN ${sql.in(CLOSED)} AND lower(title) IN ${sql.in(wanted)}
        ORDER BY +key`;
      for (const lower of wanted) memo.named.set(lower, undefined);
      for (const one of same)
        if (memo.named.get(one.lower) === undefined)
          memo.named.set(one.lower, { recordId: one.recordId, key: one.key, gstin: one.gstin });
    });

    // Only independent new entries can share a write. Refusals go through the ordered row path.
    const createPlainChunk = Effect.fn("KinImport.createPlainChunk")(function* (
      decoded: ReadonlyArray<Decoded>,
    ) {
      const first = decoded[0]?.row;
      if (first === undefined || !("entry" in first)) return false;
      const list = first.entry.list;
      // Other lists can need per-row issuance, name matching, links, or date-based start states.
      if ((list !== "work" && list !== "expenses") || failedLists.has(list)) return false;
      const specs: Array<ImportEntry> = [];
      const sources = new Set<string>();
      for (const { row } of decoded) {
        if (row === undefined || !("entry" in row)) return false;
        const spec = row.entry;
        if (
          spec.list !== list ||
          spec.client !== undefined ||
          spec.project !== undefined ||
          spec.number !== undefined ||
          spec.suggested === true ||
          // Explicitly confirmed amounts can become the next row's stored slip baseline.
          spec.confirmed === true ||
          (spec.payments?.length ?? 0) > 0 ||
          Object.keys(spec.fields ?? {}).length > 0 ||
          seen.entry.has(spec.source) ||
          sources.has(spec.source) ||
          memo.found.get(originOf("entry", spec.source)) !== undefined
        )
          return false;
        specs.push(spec);
        sources.add(spec.source);
      }

      const def = yield* listOf(list);
      if (def === undefined) return false;
      const pending = new Map<string, bigint>();
      const inputs = [];
      for (const spec of specs) {
        if (company.pending && withMoney(spec, def)) return false;
        const parsed = amountOf(spec, def);
        if (parsed !== undefined && "error" in parsed) return false;
        const amount = parsed?.money;
        if ((yield* slip(spec, def, amount, pending)) !== undefined) return false;
        const open = openFor(spec, def, amount, []);
        inputs.push({ spec, amount, open, input: entryInput(spec, def, amount, open, []) });
      }
      if (
        !(yield* records.createImportChunk(
          orgId,
          owner,
          list,
          inputs.map((one) => one.input),
        ))
      )
        return false;
      for (const [slot, most] of pending) largest.set(slot, most);
      for (const { spec, amount, open } of inputs) {
        seen.entry.add(spec.source);
        tally(spec, def, amount, open);
      }
      counts.entries.create += inputs.length;
      return true;
    });

    const rolledBack = <A, R>(work: Effect.Effect<A, Failure, R>) =>
      sql
        .withTransaction(work.pipe(Effect.andThen(Effect.fail(new Rollback()))))
        .pipe(Effect.catchTags({ KinImportRollback: () => Effect.void }));

    const started = Effect.fn("KinImport.started")(function* (
      action: "apply" | "check",
      lists: ReadonlyArray<string>,
    ) {
      const [row] = yield* sql<{ seq: number }>`INSERT INTO kin_import_runs (org_id, batch,
          action, person_id, started_at, lists_json, summary_json)
        VALUES (${orgId}, ${doc.batch}, ${action}, ${owner}, ${now}, ${encodeJson(lists)},
          ${encodeJson({ done: 0, rows: scan.rows, beat: now, ...(options.file === undefined ? {} : { file: options.file }) })})
        RETURNING seq`;
      return row?.seq;
    });
    // The run's own row commits with its lists, so an undo knows which lists the batch made.
    const begin = Effect.gen(function* () {
      if (options.guard !== undefined) yield* options.guard;
      if (keep) yield* notImporting(orgId);
      yield* defineLists(true);
      if (!keep) return undefined;
      const made = listReport.filter((one) => one.action === "create").map((one) => one.list);
      return yield* started("apply", made);
    });
    const runSeq = keep
      ? yield* sql.withTransaction(begin)
      : yield* rolledBack(begin).pipe(Effect.as(undefined));
    // A check keeps only its own row while it runs, so how far it is reads as an import's does.
    const checkSeq = keep ? undefined : yield* started("check", []);
    watched.seq = runSeq ?? checkSeq ?? null;
    yield* refreshes.touch(orgId, "imports");

    let done = 0;
    yield* lines.pipe(
      Stream.zipWithIndex,
      Stream.grouped(CHUNK),
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          const decoded: Array<Decoded> = [];
          for (const [text, index] of chunk)
            if (index + 1 > scan.headerAt && text.trim() !== "") {
              const one = yield* decodeRow(text).pipe(Effect.result);
              decoded.push(
                one._tag === "Success"
                  ? { line: index + 1, row: one.success }
                  : { line: index + 1, row: undefined, failure: one.failure.message },
              );
            }
          const work = Effect.gen(function* () {
            if (!keep) yield* defineLists(false);
            yield* prefetch(decoded);
            const dealsOn =
              !decoded.some(({ row }) => row !== undefined && "deal" in row) ||
              (yield* sectionOn(orgId, "deals"));
            // With Deals off the gate is per row, so the chunk path is skipped.
            if (!dealsOn || !(yield* createPlainChunk(decoded)))
              for (const one of decoded) yield* rowStep(one, dealsOn);
            // What it filled and how far it got commit with the chunk, so an undo after a crash
            // still empties what it filled, and anyone reading the run sees where it stands.
            if (runSeq !== undefined) {
              const fresh = fills.slice(fillsWritten);
              // Appended, not written whole: a large file's fills would be rewritten every chunk.
              const summary =
                fresh.length === 0
                  ? sql`COALESCE(summary_json, '{}')`
                  : sql`json_set(COALESCE(summary_json, '{}'), '$.filled', json((
                      SELECT json_group_array(json(value)) FROM (
                        SELECT value FROM json_each(COALESCE(summary_json, '{}'), '$.filled')
                        UNION ALL SELECT value FROM json_each(${encodeJson(fresh)})))))`;
              yield* sql`UPDATE kin_import_runs
                SET summary_json = json_set(${summary}, '$.done', ${done + decoded.length},
                  '$.beat', ${yield* Clock.currentTimeMillis},
                  '$.rows', ${scan.rows}, '$.clients', json(${encodeJson(counts.clients)}),
                  '$.contacts', json(${encodeJson(counts.contacts)}),
                  '$.deals', json(${encodeJson(counts.deals)}),
                  '$.entries', json(${encodeJson(counts.entries)}),
                  '$.projects', json(${encodeJson(counts.projects)}))
                WHERE seq = ${runSeq}`;
              fillsWritten = fills.length;
            }
          });
          if (keep) yield* sql.withTransaction(work);
          else yield* rolledBack(work);
          if (checkSeq !== undefined)
            yield* sql`UPDATE kin_import_runs
              SET summary_json = json_set(summary_json, '$.done', ${done + decoded.length},
                '$.beat', ${yield* Clock.currentTimeMillis})
              WHERE seq = ${checkSeq}`;
          forget();
          done += decoded.length;
          watched.done = done;
          yield* refreshes.touch(orgId, "imports");
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
      taxIdLabel: regionOf(company.country)?.taxIdLabel ?? "tax id",
      clientMatches,
      money: byName(money).map(([, one]) => ({
        list: one.list,
        entries: one.entries,
        total: asMoney(one.total, one.currency),
        paid: asMoney(one.paid, one.currency),
      })),
      stale: byName(stale).map(([list, one]) => ({ list, ...one })),
      filled: fills.length,
      prospects,
      problems,
      more,
    };
    if (runSeq !== undefined) {
      const finished = yield* Clock.currentTimeMillis;
      yield* sql`UPDATE kin_import_runs SET finished_at = ${finished},
          summary_json = ${encodeJson({ ...counts, rows: scan.rows, filled: fills, ...(options.file === undefined ? {} : { file: options.file }) })}
        WHERE seq = ${runSeq}`;
      if (counts.clients.create > 0) yield* refreshes.touch(orgId, "workChoices");
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

  const entryFor = Effect.fn("KinImport.entryFor")(function* (
    action: ImportLive["action"],
    personId: KinPersonId,
    batch: string,
  ) {
    return {
      action,
      personId,
      startedAt: yield* Clock.currentTimeMillis,
      batch,
      file: null,
      seq: null,
      done: 0,
      of: 0,
    } satisfies ImportLive;
  });

  return KinImport.of({
    plan: Effect.fn("KinImport.plan")(function* (orgId, owner, lines, options) {
      const entry = yield* entryFor("check", owner, "");
      const forget = Effect.suspend(() =>
        entry.seq === null
          ? Effect.void
          : sql`DELETE FROM kin_import_runs WHERE seq = ${entry.seq} AND action = 'check'`.pipe(
              Effect.ignore,
            ),
      );
      return yield* tracked(orgId, entry, (one) =>
        run(orgId, owner, lines, false, options ?? {}, one).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.ensuring(forget),
        ),
      );
    }),
    apply: Effect.fn("KinImport.apply")(function* (orgId, owner, lines, options) {
      const entry = yield* entryFor("apply", owner, "");
      return yield* tracked(orgId, entry, (one) =>
        run(orgId, owner, lines, true, options ?? {}, one).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
      );
    }),
    undo: Effect.fn("KinImport.undo.run")(function* (orgId, owner, batch, options) {
      const work = Effect.fn("KinImport.undo.work")(function* (entry: ImportLive | undefined) {
        const undone = yield* undoBatch(orgId, owner, batch, options, entry).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(KinRecords, records),
          Effect.provideService(KinRefreshObserver, refreshes),
        );
        // An undo deletes entries outright, so no logged change tells anyone it happened.
        if (undone.applied) {
          yield* records.announce(orgId);
          if (undone.removes.clients + undone.removes.projects > 0)
            yield* refreshes.touch(orgId, "workChoices");
        }
        return undone;
      });
      if (!options.apply) return yield* work(undefined);
      return yield* tracked(orgId, yield* entryFor("undo", owner, batch), work);
    }),
    fromFile,
    running: Effect.fn("KinImport.running")((orgId) =>
      Effect.sync(() =>
        [...(live.get(orgId) ?? [])]
          .map((one) => ({ ...one }))
          .toSorted((a, b) => a.startedAt - b.startedAt),
      ),
    ),
  });
});

export const layer = Layer.effect(KinImport, make);
