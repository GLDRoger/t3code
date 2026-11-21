import {
  KIN_EXPORT_HOLDS,
  KIN_EXPORT_LEAVES,
  KIN_EXPORT_ROUTE,
  KinChatError,
  KinAttachment,
  KinDocFile,
  type KinExportLink,
  type KinExportLinkInput,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import { base64UrlDecodeUtf8, base64UrlEncode } from "../../auth/utils.ts";
import type { PayloadSigner } from "../../auth/PayloadSigner.ts";
import type { SecretStoreError } from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { accessOf } from "../people/KinAccess.ts";
import type {
  ImportClient,
  ImportEntry,
  ImportHeader,
  ImportList,
  ImportProject,
} from "./importFormat.ts";
import { LISTS, parseFields, type FieldValues } from "./lists.ts";
import { currencyDigits, dayIn } from "./money.ts";
import { iso, ownerZone, workFailure } from "./recordRows.ts";
import { allLists, keyFor, PRESETS, type ListDef, type PresetId } from "./registers.ts";
import { zipStream, type ZipEntry } from "./zipStream.ts";

/**
 * Everything the owner can take away: the company's clients, projects and entries as the JSONL
 * `kin import` reads, its docs as files, and the files its entries and docs hold, as one zip
 * streamed page by page. Memory stays in its own repository. Only these tables are read, so no
 * connection token, key, session, pairing code, invite or push token can be in it.
 */
export const EXPORT_READS = [
  "kin_orgs",
  "kin_registers",
  "kin_records",
  "kin_record_payments",
  "kin_issued_numbers",
  "kin_doc_versions",
  "kin_doc_files",
  "kin_record_comments",
  "kin_client_touches",
  "kin_people",
] as const;

/** Rows `kin import` takes as entries; the rest are rows of their own or files here. */
const NOT_ENTRIES = ["clients", "projects", "docs"];
const PAGE = 200;
const LINK_TTL_MS = 10 * 60 * 1000;
const NUMBER = /^[A-Za-z0-9/-]{1,32}$/;

const ExportClaims = Schema.Struct({
  kind: Schema.Literal("kin-export"),
  orgId: Schema.String,
  reader: Schema.String,
  expiresAt: Schema.Number,
});
const ClaimsJson = Schema.fromJsonString(ExportClaims);
const encodeClaims = Schema.encodeSync(ClaimsJson);
const decodeClaims = Schema.decodeUnknownOption(ClaimsJson);

const ownerOnly = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner can download everything.",
});

/** The owner of `orgId` among the caller's people, or the refusal. */
export const theOrgOwner = Effect.fn("KinExport.owner")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  const person = people.find((one) => one.orgId === orgId);
  if (person === undefined || (yield* accessOf(orgId, person.personId)) !== "owner")
    return yield* ownerOnly;
  return person;
});

const fileNameFor = (name: string, now: number, zone: string) =>
  `${
    name
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "kin"
  }-${dayIn(now, zone)}.zip`;

/** A short-lived link to the zip, for this session only; the route checks both again. */
export const exportLink = Effect.fn("KinExport.link")(function* (
  people: ReadonlyArray<PersonIdentity>,
  reader: string,
  signer: PayloadSigner<SecretStoreError>,
  input: KinExportLinkInput,
) {
  yield* theOrgOwner(people, input.orgId);
  const sql = yield* SqlClient.SqlClient;
  const [org] = yield* sql<{
    name: string;
  }>`SELECT name FROM kin_orgs WHERE org_id = ${input.orgId}`;
  const now = yield* Clock.currentTimeMillis;
  const expiresAt = now + LINK_TTL_MS;
  const payload = base64UrlEncode(
    encodeClaims({ kind: "kin-export", orgId: input.orgId, reader, expiresAt }),
  );
  const signature = yield* signer.sign(payload).pipe(
    Effect.mapError(
      () =>
        new KinChatError({
          reason: "unavailable",
          message: "The download couldn't be prepared.",
        }),
    ),
  );
  const fileName = fileNameFor(org?.name ?? "kin", now, yield* ownerZone(input.orgId));
  return {
    url: `${KIN_EXPORT_ROUTE}/${payload}.${signature}/${encodeURIComponent(fileName)}`,
    fileName,
    expiresAt: iso(expiresAt),
  } satisfies KinExportLink;
}, workFailure);

/** The org and session a link was made for, when its signature holds and it hasn't expired. */
export const readExportToken = Effect.fn("KinExport.readToken")(function* (
  token: string,
  signer: PayloadSigner<SecretStoreError>,
) {
  const [payload, signature] = token.split(".");
  if (payload === undefined || signature === undefined) return Option.none();
  const valid = yield* signer.verify(payload, signature).pipe(Effect.orElseSucceed(() => false));
  if (!valid) return Option.none();
  const claims = Option.flatMap(
    Option.liftThrowable(() => base64UrlDecodeUtf8(payload))(),
    decodeClaims,
  );
  const now = yield* Clock.currentTimeMillis;
  return Option.filter(claims, (one) => one.expiresAt > now);
});

const decimal = (minor: number, currency: string) => {
  const digits = currencyDigits(currency);
  const text = String(minor).padStart(digits + 1, "0");
  return digits === 0 ? text : `${text.slice(0, -digits)}.${text.slice(-digits)}`;
};
const line = (row: unknown) => `${JSON.stringify(row)}\n`;
const some = <A>(key: string, value: A | null | undefined | "") =>
  value === null || value === undefined || value === "" ? {} : { [key]: value };

type RecordRow = {
  readonly recordId: string;
  readonly registerId: string;
  readonly key: string;
  readonly title: string;
  readonly state: ImportEntry["state"] & string;
  readonly category: string | null;
  readonly partyId: string | null;
  readonly projectId: string | null;
  readonly dueAt: number | null;
  readonly dueAllDay: number;
  readonly dateAt: number | null;
  readonly dateAllDay: number;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly sensitive: number;
  readonly confirmed: number;
  readonly notes: string;
  readonly fieldsJson: string;
  readonly createdAt: number;
  readonly closedAt: number | null;
};

/** The definition `kin import` makes this list from again. */
const listSpec = (def: ListDef): ImportList => {
  const preset = (Object.hasOwn(PRESETS, def.id) ? PRESETS[def.id as PresetId] : undefined) as
    | (typeof PRESETS)[PresetId]
    | undefined;
  const fields = def.fields.flatMap((one): Array<NonNullable<ImportList["fields"]>[number]> => {
    if (one.retired === true) return [];
    const had = preset?.fields.find((field) => field.key === one.key);
    if (had !== undefined) {
      // A template's field comes back with the template; only choices added to it travel.
      const added = (one.choices ?? []).filter((item) => !(had.choices ?? []).includes(item));
      return one.type === "choice" && added.length > 0
        ? [{ label: had.label, type: one.type, choices: added }]
        : [];
    }
    return [
      {
        label: one.label,
        type: one.type,
        ...some("choices", one.choices),
        ...some("link", one.link),
        ...(one.sensitive && one.type !== "money" && one.type !== "file"
          ? { sensitive: true }
          : {}),
      },
    ];
  });
  const categories = def.categories.filter((one) => !preset?.categories.includes(one));
  const extras = {
    ...(fields.length === 0 ? {} : { fields }),
    ...(categories.length === 0 ? {} : { categories }),
    ...(def.categoryLabels === undefined ? {} : { categoryLabels: def.categoryLabels }),
    ...(def.numbering === undefined ? {} : { numbering: def.numbering }),
  };
  if (preset !== undefined) return { list: def.id, ...extras };
  return {
    list: def.id,
    name: def.name,
    noun: def.noun,
    prefix: def.prefix,
    states: def.states,
    ...(Object.keys(def.stateLabels).length === 0 ? {} : { stateNames: def.stateLabels }),
    amount: def.amount,
    currency: def.currency,
    sensitive: def.sensitive,
    ...(def.payments === true ? { payments: true } : {}),
    ...some("dueLabel", def.dueLabel),
    ...some("dateLabel", def.dateLabel),
    ...extras,
  };
};

const make = Effect.fn("KinExport.make")(function* (orgId: KinOrgId, owner: KinPersonId) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const zone = yield* ownerZone(orgId);
  const [org] = yield* sql<{ name: string }>`SELECT name FROM kin_orgs WHERE org_id = ${orgId}`;
  const lists = yield* allLists(orgId);
  const defined = [...lists.values()].filter((def) => def.builtIn === null);
  const parties = new Map(
    (yield* sql<{ recordId: string; key: string }>`SELECT record_id AS "recordId", key
      FROM kin_records WHERE org_id = ${orgId} AND register_id IN ('clients', 'projects')
      ORDER BY record_id`).map((row) => [row.recordId, row.key] as const),
  );
  const files: Array<{
    readonly folder: string;
    readonly attachmentId: string;
    readonly name?: string;
  }> = [];
  const keepFile = (folder: string, attachmentId: string, name?: string) => {
    if (!files.some((one) => one.folder === folder && one.attachmentId === attachmentId))
      files.push({ folder, attachmentId, ...(name === undefined ? {} : { name }) });
  };

  const day = (ms: number | null, allDay: number) =>
    ms === null ? undefined : allDay === 1 ? dayIn(ms, zone) : iso(ms);

  /** A field as `kin import` takes it; what it can't take (files, other people, lists of names) stays out. */
  const fieldsOf = (row: RecordRow, def: ListDef | undefined) => {
    const values: FieldValues = parseFields(row.fieldsJson);
    const out: Record<string, string | { amount: string; currency: string }> = {};
    const builtIn = LISTS[row.registerId as keyof typeof LISTS];
    for (const [key, value] of Object.entries(values)) {
      const spec = def?.fields.find((one) => one.key === key);
      if (spec?.type === "file") {
        for (const id of Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
          keepFile(`files/${row.key}`, id);
        continue;
      }
      if (spec?.retired === true) continue;
      if (def?.builtIn === null && spec === undefined) continue;
      if (def?.builtIn !== null && builtIn !== undefined && !builtIn.fields.includes(key)) continue;
      // A field added to a list is made again by its label, so it carries the label's key.
      const preset = Object.hasOwn(PRESETS, row.registerId)
        ? PRESETS[row.registerId as PresetId]
        : undefined;
      const outKey =
        spec === undefined || preset?.fields.some((one) => one.key === key) || def?.builtIn !== null
          ? key
          : (keyFor(spec.label) ?? key);
      if (typeof value === "object" && !Array.isArray(value) && "currency" in value) {
        out[outKey] = { amount: decimal(value.minor, value.currency), currency: value.currency };
      } else if (typeof value === "string") {
        if (spec?.type === "person") {
          if (value === `person:${owner}`) out[outKey] = "owner";
        } else if (spec?.type === "link") {
          const linked = parties.get(value);
          if (linked !== undefined) out[outKey] = linked;
        } else if (value.trim() !== "" && value.length <= 500) out[outKey] = value;
      }
    }
    return out;
  };

  const selectRecords = sql`SELECT record_id AS "recordId", register_id AS "registerId", key,
      title, state, category, party_id AS "partyId", project_id AS "projectId", due_at AS "dueAt",
      due_all_day AS "dueAllDay", date_at AS "dateAt", date_all_day AS "dateAllDay",
      amount_minor AS "amountMinor", currency, sensitive, confirmed, notes,
      fields_json AS "fieldsJson", created_at AS "createdAt", closed_at AS "closedAt"
    FROM kin_records`;
  /** One register's rows in pages, so a company's whole history never sits in memory. */
  const pages = (registers: ReadonlyArray<string>, not: boolean) =>
    Stream.paginate("", (after: string) =>
      sql<RecordRow>`${selectRecords} WHERE org_id = ${orgId}
          AND ${not ? sql`register_id NOT IN ${sql.in(registers)}` : sql`register_id IN ${sql.in(registers)}`}
          AND record_id > ${after} ORDER BY record_id LIMIT ${PAGE}`.pipe(
        Effect.map(
          (rows) =>
            [
              rows,
              rows.length < PAGE ? Option.none() : Option.some(rows.at(-1)!.recordId),
            ] as const,
        ),
      ),
    );

  const header: ImportHeader = {
    format: "kin-import",
    version: 1,
    batch: "kin-export",
    ...some("source", (org?.name ?? "").slice(0, 60).trim()),
    ...(defined.length === 0 ? {} : { lists: defined.map(listSpec) }),
  };
  const clientRows = pages(["clients"], false).pipe(
    Stream.map((row) => {
      const fields = parseFields(row.fieldsJson);
      const text = (key: string) => {
        const value = fields[key];
        return typeof value === "string" && value.trim() !== "" ? value : undefined;
      };
      const client: ImportClient = {
        source: row.key,
        name: row.title,
        ...(row.category === "vendor" || row.category === "client" ? { kind: row.category } : {}),
        ...(row.state === "dropped" ? { state: "dropped" as const } : {}),
        ...some("gstin", text("gstin")),
        ...some("address", text("address")),
        ...some("terms", text("terms")),
        ...some("placeOfSupply", text("placeOfSupply")),
        ...some("notes", row.notes),
        ...(row.sensitive === 1 ? { sensitive: true } : {}),
        createdAt: iso(row.createdAt),
      };
      return line({ client });
    }),
  );
  const projectRows = pages(["projects"], false).pipe(
    Stream.map((row) => {
      const project: ImportProject = {
        source: row.key,
        name: row.title,
        ...some("client", row.partyId === null ? undefined : parties.get(row.partyId)),
        ...(row.state === "done" || row.state === "dropped" ? { state: row.state } : {}),
        ...some("target", day(row.dueAt, row.dueAllDay)),
        ...some("notes", row.notes),
        ...(row.sensitive === 1 ? { sensitive: true } : {}),
        createdAt: iso(row.createdAt),
        ...some("closedAt", row.closedAt === null ? undefined : iso(row.closedAt)),
      };
      return line({ project });
    }),
  );
  const entryRows = Stream.paginate("", (after: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<RecordRow>`${selectRecords} WHERE org_id = ${orgId}
          AND register_id NOT IN ${sql.in(NOT_ENTRIES)} AND record_id > ${after}
          ORDER BY record_id LIMIT ${PAGE}`;
      const ids = rows.map((row) => row.recordId);
      const payments =
        ids.length === 0
          ? []
          : yield* sql<{
              paymentId: string;
              recordId: string;
              amountMinor: number;
              currency: string;
              paidOn: string;
              note: string;
            }>`SELECT payment_id AS "paymentId", record_id AS "recordId",
                amount_minor AS "amountMinor", currency, paid_on AS "paidOn", note
              FROM kin_record_payments WHERE org_id = ${orgId} AND voided_at IS NULL
                AND record_id IN ${sql.in(ids)} ORDER BY paid_on, payment_id`;
      const numbers =
        ids.length === 0
          ? []
          : yield* sql<{ recordId: string; number: string }>`SELECT record_id AS "recordId",
                number FROM kin_issued_numbers WHERE org_id = ${orgId}
                AND record_id IN ${sql.in(ids)} ORDER BY record_id`;
      const lines = rows.map((row) => {
        const def = lists.get(row.registerId);
        const number = numbers.find((one) => one.recordId === row.recordId)?.number;
        const paid = payments.filter((one) => one.recordId === row.recordId);
        const fields = fieldsOf(row, def);
        const entry: ImportEntry = {
          source: row.key,
          list: row.registerId,
          title: row.title,
          state: row.state,
          ...some("category", row.category),
          ...some("client", row.partyId === null ? undefined : parties.get(row.partyId)),
          ...some("project", row.projectId === null ? undefined : parties.get(row.projectId)),
          ...some("due", day(row.dueAt, row.dueAllDay)),
          ...some("date", day(row.dateAt, row.dateAllDay)),
          ...(row.amountMinor === null || row.currency === null
            ? {}
            : { amount: decimal(row.amountMinor, row.currency), currency: row.currency }),
          ...some("notes", row.notes),
          ...(Object.keys(fields).length === 0 ? {} : { fields }),
          ...(row.sensitive === 1 ? { sensitive: true } : {}),
          ...(row.confirmed === 0 ? { suggested: true } : {}),
          ...(number !== undefined && NUMBER.test(number) ? { number } : {}),
          createdAt: iso(row.createdAt),
          ...some("closedAt", row.closedAt === null ? undefined : iso(row.closedAt)),
          ...(paid.length === 0
            ? {}
            : {
                payments: paid.map((one) => ({
                  source: one.paymentId,
                  amount: decimal(one.amountMinor, one.currency),
                  currency: one.currency,
                  paidOn: one.paidOn,
                  ...some("note", one.note),
                })),
              }),
        };
        return line({ entry });
      });
      return [
        lines,
        rows.length < PAGE ? Option.none() : Option.some(rows.at(-1)!.recordId),
      ] as const;
    }),
  );

  /** Each doc as it reads now: its markdown, or the file it is. */
  const docEntries = pages(["docs"], false).pipe(
    Stream.mapEffect((row) =>
      Effect.gen(function* () {
        const [latest] = yield* sql<{
          bodyKind: string;
          body: string;
          attachmentId: string | null;
          fileJson: string | null;
        }>`SELECT body_kind AS "bodyKind", body, file_attachment_id AS "attachmentId",
            file_json AS "fileJson"
          FROM kin_doc_versions WHERE org_id = ${orgId} AND record_id = ${row.recordId}
          ORDER BY version DESC LIMIT 1`;
        const shown = yield* sql<{ attachmentId: string }>`SELECT attachment_id AS "attachmentId"
          FROM kin_doc_files WHERE org_id = ${orgId} AND record_id = ${row.recordId}
          ORDER BY attachment_id`;
        for (const one of shown) keepFile(`docs/${row.key}`, one.attachmentId);
        if (latest?.bodyKind === "file" && latest.attachmentId !== null) {
          keepFile(
            "docs",
            latest.attachmentId,
            `${row.key} ${safeName(fileNameOf(latest.fileJson) ?? row.title)}`,
          );
          return [];
        }
        const name = `docs/${row.key} ${safeName(row.title)}.md`;
        return [{ name, data: text(`# ${row.title}\n\n${latest?.body ?? ""}\n`) }];
      }),
    ),
    Stream.flatMap((entries) => Stream.fromIterable(entries)),
  );

  /** Each entry's comments, oldest first, and the files they hold. */
  const commentRows = Stream.paginate({ key: "", seq: 0 }, (after: { key: string; seq: number }) =>
    sql<{
      key: string;
      seq: number;
      at: number;
      byKind: string;
      by: string | null;
      body: string;
      filesJson: string;
    }>`
      SELECT r.key, c.seq, c.created_at AS at, c.author_kind AS "byKind",
        p.display_name AS by, c.body, c.files_json AS "filesJson"
      FROM kin_record_comments c
      JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
      LEFT JOIN kin_people p ON c.author_kind = 'person' AND p.org_id = c.org_id
        AND p.person_id = c.author_id
      WHERE c.org_id = ${orgId} AND c.removed_at IS NULL AND (r.key, c.seq) > (${after.key}, ${after.seq})
      ORDER BY r.key, c.seq LIMIT ${PAGE}`.pipe(
      Effect.map((rows) => {
        const lines = rows.map((row) => {
          const files = Option.getOrElse(decodeCommentFiles(row.filesJson), () => []);
          for (const one of files) keepFile(`files/${row.key}`, one.id, safeName(one.name));
          return line({
            entry: row.key,
            at: iso(row.at),
            by: row.byKind === "agent" ? "agent" : (row.by ?? "person"),
            text: row.body,
            ...(files.length === 0 ? {} : { files: files.map((one) => safeName(one.name)) }),
          });
        });
        const last = rows.at(-1);
        return [
          lines,
          rows.length < PAGE || last === undefined
            ? Option.none()
            : Option.some({ key: last.key, seq: last.seq }),
        ] as const;
      }),
    ),
  ).pipe(Stream.flatMap((lines) => Stream.fromIterable(lines)));

  /** Contact logged with each client, oldest first. */
  const contactRows = Stream.paginate("", (after: string) =>
    sql<{
      touchId: string;
      client: string;
      at: number;
      kind: string;
      who: string | null;
      note: string;
    }>`
      SELECT t.touch_id AS "touchId", r.key AS client, t.at, t.kind, p.display_name AS who, t.note
      FROM kin_client_touches t
      JOIN kin_records r ON r.org_id = t.org_id AND r.record_id = t.party_id
      LEFT JOIN kin_people p ON p.org_id = t.org_id AND p.person_id = t.person_id
      WHERE t.org_id = ${orgId} AND t.removed_at IS NULL AND t.touch_id > ${after}
      ORDER BY t.touch_id LIMIT ${PAGE}`.pipe(
      Effect.map(
        (rows) =>
          [
            rows.map((row) =>
              line({
                client: row.client,
                at: iso(row.at),
                kind: row.kind,
                ...some("who", row.who),
                ...some("note", row.note),
              }),
            ),
            rows.length < PAGE ? Option.none() : Option.some(rows.at(-1)!.touchId),
          ] as const,
      ),
    ),
  ).pipe(Stream.flatMap((lines) => Stream.fromIterable(lines)));

  const fileEntries = Stream.suspend(() => Stream.fromIterable(files)).pipe(
    Stream.mapEffect((one) =>
      Effect.gen(function* () {
        const path = resolveAttachmentPathById({ attachmentsDir, attachmentId: one.attachmentId });
        if (path === null || !(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))))
          return [];
        const name = one.name ?? `${one.attachmentId}${extname(path)}`;
        return [{ name: `${one.folder}/${name}`, data: fs.stream(path).pipe(Stream.orDie) }];
      }),
    ),
    Stream.flatMap((one) => Stream.fromIterable(one)),
  );

  const readme = [
    `Everything Kin keeps for ${org?.name ?? "the company"}, taken out on ${dayIn(yield* Clock.currentTimeMillis, zone)}.`,
    "",
    KIN_EXPORT_HOLDS,
    "",
    KIN_EXPORT_LEAVES,
    "",
    "kin.jsonl  Clients, contacts, projects, every list and its entries with their payments, in the format `kin import` reads.",
    "           Restore it on the computer running Kin with: t3 kin import --file kin.jsonl --apply",
    "           What it makes is owned by whoever imports it.",
    "docs/      Each doc as it reads now, and the files docs show.",
    "files/     Files kept on entries, such as invoice PDFs and receipts, and on their comments.",
    "comments.jsonl  Each entry's comments, oldest first.",
    "contacts.jsonl  The contact logged with each client: calls, meetings, emails and messages.",
    "",
  ].join("\n");

  const lines = Stream.make(line(header)).pipe(
    Stream.concat(clientRows),
    Stream.concat(projectRows),
    Stream.concat(entryRows),
  );
  return zipStream(
    Stream.fromIterable<ZipEntry<SqlError.SqlError, never>>([
      { name: "README.txt", data: text(readme) },
      { name: "kin.jsonl", data: lines.pipe(Stream.encodeText) },
      { name: "comments.jsonl", data: commentRows.pipe(Stream.encodeText) },
      { name: "contacts.jsonl", data: contactRows.pipe(Stream.encodeText) },
    ]).pipe(
      Stream.concat(docEntries),
      // Last: the docs and entries above named the files.
      Stream.concat(fileEntries),
    ),
    yield* Clock.currentTimeMillis,
  );
});

const safeName = (name: string) =>
  name
    .replace(/[\\/:*?"<>|\p{Cc}\s]+/gu, " ")
    .trim()
    .slice(0, 80) || "untitled";
const extname = (path: string) => /\.[A-Za-z0-9]{1,10}$/.exec(path)?.[0] ?? "";
const decodeDocFile = Schema.decodeUnknownOption(Schema.fromJsonString(KinDocFile));
const decodeCommentFiles = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(KinAttachment)),
);
const fileNameOf = (json: string | null) =>
  json === null ? undefined : Option.getOrUndefined(decodeDocFile(json))?.name;
const text = (value: string) => Stream.make(new TextEncoder().encode(value));

/** The zip, after checking again that `personId` is the org's owner. */
export const exportZip = Effect.fn("KinExport.zip")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  if ((yield* accessOf(orgId, personId)) !== "owner") return yield* ownerOnly;
  return yield* make(orgId, personId);
}, workFailure);
