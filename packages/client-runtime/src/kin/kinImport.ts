import {
  formatKinWhen,
  KIN_CURRENCY_CODES,
  KIN_IMPORT_MAX_FILE_BYTES,
  type KinImportApplied,
  type KinImportCheck,
  type KinImportClientDecision,
  type KinImportDateFormat,
  type KinImportDecisions,
  type KinImportFile,
  type KinImportFileInput,
  type KinImportLeftOut,
  type KinImportRun,
  type KinImportRunning,
  type KinImportTarget,
  type KinImportUndone,
  type KinImportUpload,
  KinChatError,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";

/** Every word the import screens show, on the web and the phone alike. */
export const KIN_IMPORT = {
  entry: "Import a file",
  steps: ["File", "Columns", "Check", "Done"] as const,
  title: "Bring in your clients and deals",
  intro:
    "A spreadsheet saved as CSV, or the export of the CRM you use now. Nothing is added until you check it.",
  drop: "Drop a file here, or",
  choose: "choose one",
  chooseFile: "Choose a file",
  limits: "CSV, up to 50,000 rows",
  earlier: "Earlier imports",
  noneEarlier: "Nothing imported yet.",
  undo: "Undo this import",
  undoing: "Taking the import away…",
  reading: "Reading the file…",
  columnsIntro: "Kin matched your columns by their names. Change any that are wrong.",
  yourColumn: "Your column",
  unnamed: "(no header)",
  firstValue: "First value",
  goesTo: "Goes to",
  kindHint: "Prospect, Lead → prospect; anything else → client",
  notImported: "Not imported",
  currencyAsk: "Values without a currency are in",
  currencyPick: "Pick a currency",
  otherCurrency: "Another currency…",
  currencyCode: "Its three-letter code, such as the one on your bank statement",
  dateAsk: "Days like",
  dateAskAfter: "are written",
  dayFirst: "Day first",
  monthFirst: "Month first",
  whatWillHappen: "What will happen",
  matchesTitle: "Matches what you have",
  matchesHint: "Kin adds what's new to the one you have and changes nothing you typed",
  inFile: "In the file",
  inKin: "Already in Kin",
  matchedBy: "Matched by",
  sameCompany: "Same company",
  newOne: "A new one",
  leaveOut: "Leave these rows out",
  decide: "Decide",
  needLook: "Need a look",
  keeps: "Kin keeps your",
  leftOut: "Left out",
  back: "Back",
  import: "Import",
  decideFirst: "Decide the rows marked Decide first.",
  imported: "Imported",
  noticed: "What Kin noticed",
  openDeals: "Open the Deals board",
  undoAfter:
    "Undo removes what this import made that nobody has changed since. It stays possible from Clients → Add → Import a file.",
  another: "Import another file",
  undone: "Undone",
  close: "Close",
  onlyOwner: "Only the owner or a co-owner brings a file in.",
} as const;

export const KIN_IMPORT_TARGET_LABELS: Readonly<Record<KinImportTarget, string>> = {
  skip: "Leave out",
  "client.name": "Client name",
  "client.kind": "Prospect or client",
  "client.address": "Address",
  "client.notes": "Notes",
  "client.source": "Came from",
  "client.tags": "Tags",
  "contact.name": "Contact name",
  "contact.role": "Contact role",
  "contact.email": "Contact email",
  "contact.phone": "Contact phone",
  "deal.title": "Deal",
  "deal.stage": "Deal stage",
  "deal.value": "Deal value",
  "deal.currency": "Deal currency",
  "deal.expected": "Expected",
  owner: "Looked after by",
};
/** The choices in each column's menu, in the order a person reads them. */
export const KIN_IMPORT_TARGETS: ReadonlyArray<KinImportTarget> = [
  "client.name",
  "client.kind",
  "contact.name",
  "contact.email",
  "contact.phone",
  "contact.role",
  "deal.title",
  "deal.value",
  "deal.currency",
  "deal.stage",
  "deal.expected",
  "owner",
  "client.source",
  "client.notes",
  "client.address",
  "client.tags",
  "skip",
];
export const KIN_IMPORT_DATE_FORMATS: ReadonlyArray<{
  readonly id: KinImportDateFormat;
  readonly label: string;
}> = [
  { id: "dmy", label: KIN_IMPORT.dayFirst },
  { id: "mdy", label: KIN_IMPORT.monthFirst },
];
/** The company's own currency first, then every other Kin knows. */
export const kinImportCurrencies = (home: string): ReadonlyArray<string> => [
  home,
  ...[...KIN_CURRENCY_CODES].filter((code) => code !== home).sort(),
];

const MB = 1024 * 1024;
/** Said before the file is sent, in the host's own sentence. */
export const kinImportTooBig = (bytes: number) =>
  bytes > KIN_IMPORT_MAX_FILE_BYTES
    ? `The file is over ${KIN_IMPORT_MAX_FILE_BYTES / MB} MB; Kin takes up to ${KIN_IMPORT_MAX_FILE_BYTES / MB} MB at a time. Split it into smaller files and import each.`
    : null;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** A file's bytes as the request carries them. */
export const kinImportBase64 = (bytes: Uint8Array) => {
  const out: Array<string> = [];
  for (let index = 0; index < bytes.length; index += 3) {
    const [a, b, c] = [bytes[index]!, bytes[index + 1], bytes[index + 2]];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out.push(
      B64[(n >> 18) & 63]! +
        B64[(n >> 12) & 63]! +
        (b === undefined ? "=" : B64[(n >> 6) & 63]!) +
        (c === undefined ? "=" : B64[n & 63]!),
    );
  }
  return out.join("");
};

const number = (value: number) => value.toLocaleString("en-US");
const plural = (count: number, one: string, many: string) =>
  `${number(count)} ${count === 1 ? one : many}`;
const listed = (parts: ReadonlyArray<string>) =>
  parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}`;

export const kinImportProgress = (doing: "reading" | "checking" | "importing", rows: number) =>
  doing === "reading"
    ? KIN_IMPORT.reading
    : `${doing === "checking" ? "Checking" : "Importing"} ${plural(rows, "row", "rows")}…`;
/** How far a check, import or undo is, from the host's own count; null before it has one. */
export const kinImportRunningLine = (running: KinImportRunning) =>
  running.of === 0
    ? null
    : running.action === "check"
      ? `Checking ${number(running.done)} of ${plural(running.of, "row", "rows")}`
      : running.action === "apply"
        ? `Adding ${number(running.done)} of ${plural(running.of, "row", "rows")}`
        : `Taking away ${number(running.done)} of ${plural(running.of, "record", "records")}`;
/** Someone's run, as anyone opening Import sees it: who, which file, how far. */
export const kinImportRunningByLine = (running: KinImportRunning, by: string) =>
  [
    by,
    running.file ?? running.batch,
    kinImportRunningLine(running) ??
      (running.action === "check"
        ? "Checking…"
        : running.action === "apply"
          ? "Importing…"
          : KIN_IMPORT.undoing),
  ].join(" · ");
/** A run of `action` on `batch` going on now, if the host is running one. */
export const kinImportRunningOf = (
  running: ReadonlyArray<KinImportRunning> | undefined,
  action: KinImportRunning["action"],
  batch: string | null,
) => (running ?? []).find((one) => one.action === action && one.batch === batch) ?? null;
/** Whether an import or undo runs now: a second one waits for it. */
export const kinImportWriting = (running: ReadonlyArray<KinImportRunning> | undefined) =>
  (running ?? []).some((one) => one.action !== "check");
/** An import or its undo that stopped part way, and what brings in or takes away the rest. */
export const kinImportStoppedLines = (run: KinImportRun) => [
  ...(run.stopped === undefined
    ? []
    : [
        `Stopped after ${number(run.stopped.done)} of ${plural(run.stopped.of, "row", "rows")} when Kin stopped. Import the file again to bring in the rest, or undo what came in.`,
      ]),
  ...(run.undoStopped === undefined || run.undone !== null
    ? []
    : [
        `The undo stopped after ${number(run.undoStopped.done)} of ${plural(run.undoStopped.of, "record", "records")} when Kin stopped. Undo it again to take the rest away.`,
      ]),
];
export const kinImportFileLine = (name: string, rows: number) =>
  `${name} · ${plural(rows, "row", "rows")}`;
export const kinImportCheckButton = (rows: number) => `Check ${plural(rows, "row", "rows")}`;

/** The choices a person made on the Check step, beside what the host decided by itself. */
export interface KinImportChoices {
  readonly clients: Readonly<Record<string, KinImportClientDecision>>;
  readonly stages: Readonly<Record<string, string>>;
}
export const KIN_IMPORT_NO_CHOICES: KinImportChoices = { clients: {}, stages: {} };
const foldStage = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** What a near match, a match, or an unknown stage stands at now. */
export const kinImportClientChoice = (
  check: KinImportCheck,
  choices: KinImportChoices,
  source: string,
): KinImportClientDecision | null =>
  choices.clients[source] ??
  check.matches.find((one) => one.source === source)?.decision ??
  check.decide.find((one) => one.source === source)?.decision ??
  null;
export const kinImportStageChoice = (
  check: KinImportCheck,
  choices: KinImportChoices,
  value: string,
): string | null =>
  choices.stages[foldStage(value)] ??
  check.stages.find((one) => one.value === value)?.decision ??
  null;

/** The decisions the host reads, keyed as it keys them. */
export const kinImportDecisions = (choices: KinImportChoices): KinImportDecisions => ({
  ...(Object.keys(choices.clients).length === 0 ? {} : { clients: choices.clients }),
  ...(Object.keys(choices.stages).length === 0 ? {} : { stages: choices.stages }),
});
export const kinImportChooseStage = (
  choices: KinImportChoices,
  value: string,
  stage: string,
): KinImportChoices => ({ ...choices, stages: { ...choices.stages, [foldStage(value)]: stage } });
export const kinImportChooseClient = (
  choices: KinImportChoices,
  source: string,
  decision: KinImportClientDecision,
): KinImportChoices => ({ ...choices, clients: { ...choices.clients, [source]: decision } });

/** Whether Import may run: checked, nothing asked, and every row marked Decide decided. */
export const kinImportReady = (check: KinImportCheck, choices: KinImportChoices) =>
  check.checked &&
  !check.asks.currency &&
  !check.asks.dateFormat &&
  check.decide.every((one) => kinImportClientChoice(check, choices, one.source) !== null) &&
  check.stages.every((one) => kinImportStageChoice(check, choices, one.value) !== null);

/** Rows that need a person: close names, stages the company hasn't, owners not on the team. */
export const kinImportNeedsLook = (check: KinImportCheck) =>
  check.decide.reduce((sum, one) => sum + one.rows, 0) +
  check.stages.reduce((sum, one) => sum + one.rows, 0) +
  check.ownersUnknown;

export const kinImportTiles = (check: KinImportCheck) => [
  { id: "prospects", value: check.will.prospects, label: "new prospects", alert: false },
  { id: "clients", value: check.will.clients, label: "new clients", alert: false },
  { id: "contacts", value: check.will.contacts, label: "new contacts", alert: false },
  { id: "deals", value: check.will.deals, label: "new deals", alert: false },
  { id: "matched", value: check.matched, label: "match what you have", alert: false },
  {
    id: "look",
    value: kinImportNeedsLook(check),
    label: "need a look",
    alert: kinImportNeedsLook(check) > 0,
  },
];

export const kinImportMatchedBy = (match: KinImportCheck["matches"][number]) =>
  match.by === "name" ? "name" : match.detail;
export const kinImportCloseName = "close name only";
export const kinImportStageLine = (stage: KinImportCheck["stages"][number]) =>
  stage.value === ""
    ? `${plural(stage.rows, "deal has", "deals have")} no stage.`
    : `${plural(stage.rows, "row has", "rows have")} stage "${stage.value}", which isn't one of your stages.`;
export const kinImportStagePick = (stage: { readonly name: string }) => `Put them in ${stage.name}`;
export const kinImportOwnersLine = (count: number) =>
  `${plural(count, "row names", "rows name")} an owner who isn't on the team. They'll be looked after by you.`;
export const kinImportKeptLine = (kept: ReadonlyArray<string>) =>
  `${KIN_IMPORT.keeps} ${listed(kept)}.`;
export const kinImportLeftOutLine = (item: KinImportLeftOut) =>
  item.line === null ? item.reason : `Line ${number(item.line)}: ${item.reason}`;
export const kinImportMoreLine = (more: number) =>
  more === 0 ? null : `And ${plural(more, "more line", "more lines")}.`;

const countsParts = (counts: {
  readonly prospects?: number;
  readonly clients: number;
  readonly contacts: number;
  readonly deals: number;
  readonly other?: number;
}) => [
  ...(counts.prospects === undefined || counts.prospects === 0
    ? []
    : [plural(counts.prospects, "prospect", "prospects")]),
  ...(counts.clients === 0 ? [] : [plural(counts.clients, "client", "clients")]),
  ...(counts.contacts === 0 ? [] : [plural(counts.contacts, "contact", "contacts")]),
  ...(counts.deals === 0 ? [] : [plural(counts.deals, "deal", "deals")]),
  ...(counts.other === undefined || counts.other === 0
    ? []
    : [plural(counts.other, "other entry", "other entries")]),
];

export const kinImportDoneLine = (applied: KinImportApplied) => {
  const added = countsParts(applied.added);
  const total =
    applied.added.prospects + applied.added.clients + applied.added.contacts + applied.added.deals;
  return [
    added.length === 0
      ? "Nothing new: everything in the file is already in Kin."
      : `${listed(added)} ${total === 1 ? "is" : "are"} in Kin.`,
    ...(applied.matched === 0 ? [] : [`${number(applied.matched)} matched what you had.`]),
  ].join(" ");
};
export const kinImportNoticed = (applied: KinImportApplied) => [
  ...(applied.noticed.noNextStep === 0
    ? []
    : [
        `${plural(applied.noticed.noNextStep, "open deal has", "open deals have")} no next step. They show as such on the Deals board; nobody is pinged for imported deals until each person's morning page.`,
      ]),
  ...(applied.noticed.datesPassed === 0
    ? []
    : [
        `${plural(applied.noticed.datesPassed, "deal's expected day has", "deals' expected days have")} already passed.`,
      ]),
  ...(applied.filled === 0
    ? []
    : [
        `Filled in empty fields on ${plural(applied.filled, "client or contact", "clients and contacts")} you had; nothing you typed changed.`,
      ]),
];

export const kinImportUndoneLines = (undone: KinImportUndone) => {
  const removed = countsParts(undone.removed);
  return [
    removed.length === 0 ? "Nothing was left to take away." : `Removed ${listed(removed)}.`,
    ...(undone.restored === 0
      ? []
      : [
          `Emptied what it filled in on ${plural(undone.restored, "client or contact", "clients and contacts")}.`,
        ]),
    ...undone.kept.map((one) => `${one.key} stays: ${one.reason}.`),
  ];
};

/** A day in the reader's own zone. */
const day = (iso: string) => formatKinWhen(Date.parse(iso), "date");
/** One earlier import: its file, who ran it, when, and what it added. */
export const kinImportRunLine = (run: KinImportRun, by: string) =>
  [run.file ?? run.batch, by, day(run.at), listed(countsParts(run.added)) || "nothing added"].join(
    " · ",
  );
/** Why a batch has no Undo: it was taken away already. */
export const kinImportUndoneLine = (run: KinImportRun, by: (personId: string) => string) =>
  run.undone === null
    ? null
    : `Undone on ${day(run.undone.at)} by ${by(run.undone.by)}, so there's nothing left to undo.`;

const isKinChatError = Schema.is(KinChatError);

/**
 * Sends a file to the host once: after a check names the `upload` the host holds it under, the
 * same file goes as that. When the host no longer has it (a restart, an hour unused) it goes whole
 * again, once, without a word to the person. A host that names no upload gets the file each time.
 */
export function createKinImportFiles() {
  let held: { readonly data: string; readonly upload: KinImportUpload } | null = null;
  return async <A>(
    file: KinImportFile,
    request: (file: KinImportFileInput) => Promise<AtomCommandResult<A, unknown>>,
    /** What the host holds it under after this answer; null once it has let it go. */
    holds: (value: A) => KinImportUpload | null | undefined,
  ): Promise<AtomCommandResult<A, unknown>> => {
    const upload = held !== null && held.data === file.data ? held.upload : null;
    let result = await request(upload === null ? file : { name: file.name, upload });
    if (upload !== null && AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      if (isKinChatError(cause) && cause.reason === "not_found") {
        held = null;
        result = await request(file);
      }
    }
    if (AsyncResult.isSuccess(result)) {
      const next = holds(result.value);
      held = next == null ? null : { data: file.data, upload: next };
    }
    return result;
  };
}
