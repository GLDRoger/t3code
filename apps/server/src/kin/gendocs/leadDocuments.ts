import {
  KinChatError,
  KinDay,
  KinPersonId,
  KinRecordKey,
  KinTrimmedText,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { turnChat } from "../lead/Audience.ts";
import { isOrgPaused } from "../lead/orgState.ts";
import { toolAdmitted } from "../lead/SharedTools.ts";
import { shown } from "../work/leadDocs.ts";
import { askOwner } from "../work/leadMoney.ts";
import { recordingCurrency } from "../work/companyProfile.ts";
import { parseAmount } from "../work/money.ts";
import { admitted, askedBy, type Lead, leadTool, sourceOf, writerFor } from "../work/leadWork.ts";
import { issueEntry } from "./amounts.ts";
import { canonical, makeDocument, remakeForEntry, type Requester } from "./make.ts";
import * as Numbers from "./numbering.ts";
import { invoiceFromQuote, quotedInputs } from "./quotes.ts";
import {
  attachReceiptCard,
  cardLines,
  proposalOutcome,
  proposeReceipt,
  type ReceiptRequest,
  snapshotOf,
} from "./receiptProposals.ts";
import { createsMoney, makeReceipt } from "./receipts.ts";
import { defaultRecipes } from "./recipeDefaults.ts";
import { recipeLabelled, undoRecipe as undoLabelled } from "./recipeLabels.ts";
import { REFERENCE_CAPS } from "./references.ts";
import { KinWorkspace } from "./workspace.ts";
import { TurnEvent } from "../lead/eventIds.ts";

/**
 * `kin_recipes`, `kin_issue`, `kin_recipe_undo`, `kin_receipt`, and `kin_document`: a recipe's
 * file made in the call, or a file the agent made in its own session, filed as it is.
 */

const recipeName = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,39}$/));
export const DocumentInput = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)).annotate({
    description: "What it is, as the owner would call it: Invoice INV-12, October accounts pack.",
  }),
  recipe: Schema.optional(recipeName).annotate({
    description: "The recipe to run, from kin_recipes; with writeRecipe, the recipe to write.",
  }),
  entry: Schema.optional(KinRecordKey).annotate({
    description:
      "The entry it is for, such as INV-12, when the recipe reads one or the file is about one.",
  }),
  from: Schema.optional(KinRecordKey).annotate({
    description:
      "A quote, such as QT-3, to invoice: with the invoice recipe and no entry, Kin makes a draft invoice for its client with exactly the quote's lines, then its document. Give no lines or billing details beside it.",
  }),
  doc: Schema.optional(KinRecordKey).annotate({
    description:
      "A doc, such as D-4, to make a PDF of with the report recipe: Kin lays out its own text, so never copy it into inputs.",
  }),
  inputs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description:
      "Only the recipe's inputs that come from you, by name, as the owner said them. Kin reads every stored figure and works out every sum itself.",
  }),
  file: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))).annotate({
    description:
      "Without a recipe: the full path of a file you made with your own tools (PDF, PNG, JPEG, WebP, SVG, CSV, XLSX, DOCX, PPTX, Markdown, text or JSON), to file as it is.",
  }),
  writeRecipe: Schema.optional(Schema.Boolean).annotate({
    description:
      "Write a new recipe, or change the one named in recipe: the first call gives you a folder to edit, the next keeps it once its sample renders.",
  }),
  references: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(128))).check(
      Schema.isMaxLength(REFERENCE_CAPS.files),
    ),
  ).annotate({
    description:
      "With the first writeRecipe call: files the owner sent in this chat that show the look to copy (each the file's name as its message shows it, with or without its extension), such as an invoice in the company's existing format (PDF, PNG, JPEG, WebP or SVG). Their data never goes in the recipe.",
  }),
  sourceEventId: TurnEvent,
});
export type DocumentInput = typeof DocumentInput.Type;
export const DocumentResult = Schema.Struct({
  recipe: Schema.NullOr(Schema.String),
  /** The number the file carries; `null` for a draft or an unnumbered recipe. */
  number: Schema.NullOr(Schema.String),
  draft: Schema.Boolean,
  /** The docs made or filed, already shown as a card in the chat. */
  documents: Schema.Array(
    Schema.Struct({ key: Schema.String, title: Schema.String, version: Schema.Number }),
  ),
  sensitive: Schema.optional(Schema.Literal(true)),
  /** The draft a quote was invoiced as, made in the call. */
  entry: Schema.optional(Schema.String),
  /** writeRecipe: the folder holding the recipe to edit, until Kin keeps it. */
  folder: Schema.optional(Schema.String),
  /** writeRecipe: what to do next; a made file: what to call it. */
  next: Schema.optional(Schema.String),
});

const RecipeInputRow = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  /** `agent` when the agent gives it; otherwise where Kin reads it. */
  from: Schema.String,
  required: Schema.Boolean,
  description: Schema.optional(Schema.String),
  columns: Schema.optional(Schema.Array(Schema.String)),
});
export const RecipesResult = Schema.Struct({
  recipes: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      title: Schema.String,
      description: Schema.String,
      kind: Schema.String,
      list: Schema.NullOr(Schema.String),
      numbered: Schema.Boolean,
      /** Starts only from an owner-only turn, and makes a sensitive doc. */
      confidential: Schema.Boolean,
      inputs: Schema.Array(RecipeInputRow),
      computed: Schema.Array(Schema.String),
      outputs: Schema.Array(Schema.String),
      /** The one to use for its list unless the owner asks for another. */
      default: Schema.optional(Schema.Literal(true)),
    }),
  ),
});

export const recipes = leadTool("KinDocuments.recipes", (lead, _input: Record<string, never>) =>
  Effect.gen(function* () {
    yield* admitted(lead, "kin_recipes", {});
    const stored = yield* (yield* KinWorkspace).recipes(lead.orgId);
    const labelled = yield* Effect.forEach(stored, (recipe) => recipeLabelled(lead.orgId, recipe));
    const defaults = yield* defaultRecipes(lead.orgId, stored);
    return {
      recipes: stored.map((recipe, index) => ({
        name: recipe.name,
        title: recipe.title,
        description: recipe.description,
        kind: recipe.kind,
        list: recipe.list,
        numbered: recipe.numbered,
        confidential: recipe.sensitive || labelled[index] === true,
        inputs: recipe.inputs.map((input) => ({
          name: input.name,
          type: input.type,
          from: input.from,
          required: input.required,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.type === "table" ? { columns: Object.keys(input.columns) } : {}),
        })),
        computed: recipe.computed.map(([name]) => name),
        outputs: [...recipe.outputs],
        ...(defaults.has(recipe.name) ? { default: true as const } : {}),
      })),
    };
  }),
);

const denied = (message: string) => new KinChatError({ reason: "not_allowed", message });
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

/** The agent as a requester: its turn, the chat it answers in and the owner's message there. */
export const requesterOf = Effect.fn("KinDocuments.requester")(function* (
  lead: Lead,
  sourceEventId: string,
) {
  const source = yield* sourceOf(lead, sourceEventId);
  const writer = yield* writerFor(lead);
  const person = yield* askedBy(lead);
  return {
    _tag: "agent",
    agentId: lead.agentId,
    wakeupId: lead.wakeupId,
    writer,
    chatId: writer.chatId ?? null,
    answered:
      source === undefined || person === null || person === undefined
        ? null
        : { messageId: source.messageId, personId: KinPersonId.make(person) },
  } satisfies Requester;
});
/** Re-checked in the transaction that files the result: the turn may still make it. */
export const stillAdmitted = (lead: Lead, tool: string, args: unknown) =>
  toolAdmitted(lead, tool, args).pipe(
    Effect.flatMap((ok) =>
      ok
        ? Effect.void
        : Effect.fail(
            denied("This turn can't make documents any more, because someone else is in it."),
          ),
    ),
  );

/** `kin_document` with a recipe: Kin makes it now and shows its doc card in the chat. */
export const make = leadTool("KinDocuments.make", (lead, input: DocumentInput) =>
  Effect.gen(function* () {
    yield* admitted(lead, "kin_document", input);
    if (yield* isOrgPaused(lead.orgId))
      return yield* denied(
        "Kin is paused by the owner, so nothing new is made until they resume it.",
      );
    const requester = yield* requesterOf(lead, input.sourceEventId);
    const quoted = input.from === undefined ? undefined : yield* fromQuote(lead, input, requester);
    const entry = quoted?.entry ?? input.entry;
    const given = quoted?.given ?? input.inputs ?? {};
    const made = yield* makeDocument({
      orgId: lead.orgId,
      recipe: input.recipe!,
      entry,
      given,
      doc: input.doc,
      title: input.title,
      requester,
      jobKey: `agent:${lead.wakeupId}:${input.sourceEventId}:${input.recipe}:${entry ?? ""}:${input.title}:${canonical(given)}${input.doc === undefined ? "" : `:${input.doc}`}`,
      admit: stillAdmitted(lead, "kin_document", input),
    });
    for (const written of made.written) yield* shown(lead, written, true);
    return {
      recipe: made.recipe,
      number: made.number,
      draft: made.draft,
      documents: made.documents.map((doc) => ({
        key: doc.key,
        title: doc.title,
        version: doc.version,
      })),
      ...(made.sensitive ? { sensitive: true as const } : {}),
      ...(quoted === undefined ? {} : { entry: quoted.entry }),
      ...(made.documents.length === 0 ? {} : { next: filedLine(made.documents) }),
    };
  }),
);

const filedLine = (documents: ReadonlyArray<{ readonly title: string }>) =>
  `Filed, with its card in the chat. Call it ${documents.map((doc) => JSON.stringify(doc.title)).join(" and ")} in your reply, never by its key.`;

/**
 * An invoice draft from a quote, with the quote's own inputs the invoice recipe takes: its lines and
 * client exactly as quoted. Only what a quote doesn't carry may be given beside them.
 */
const fromQuote = Effect.fn("KinDocuments.fromQuote")(function* (
  lead: Lead,
  input: DocumentInput,
  requester: Requester,
) {
  if (input.entry !== undefined)
    return yield* invalid("Pass from to invoice a quote, or entry, not both. Nothing was made.");
  const recipe = (yield* (yield* KinWorkspace).recipes(lead.orgId)).find(
    (one) => one.name === input.recipe,
  );
  if (recipe === undefined || recipe.list !== "invoices")
    return yield* invalid(
      "A quote is invoiced with the invoices list's recipe, such as invoice. Nothing was made.",
    );
  const own = new Set(recipe.inputs.filter((one) => one.from === "agent").map((one) => one.name));
  const quoted = yield* quotedInputs(lead.orgId, input.from!);
  const copied = Object.fromEntries(Object.entries(quoted).filter(([name]) => own.has(name)));
  const overriding = Object.keys(input.inputs ?? {}).filter(
    (name) => Object.hasOwn(copied, name) || QUOTED.has(name),
  );
  if (overriding.length > 0)
    return yield* invalid(
      `from copies ${input.from}'s lines and client exactly, so ${overriding.join(", ")} can't be given with it. Make the invoice from the quote first, then change the draft. Nothing was made.`,
    );
  const made = yield* invoiceFromQuote(lead.orgId, requester.writer, input.from!);
  return { entry: made.entry.key, given: { ...copied, ...input.inputs } };
});

/** The invoice's inputs that say what is billed, and to whom: a quote's, never given beside it. */
const QUOTED = new Set(["lines", "billTo", "gstRate", "exportUnderLut"]);

export const IssueInput = Schema.Struct({
  entry: KinRecordKey.annotate({
    description: "The draft to issue or the entry to void, such as INV-12.",
  }),
  void: Schema.optional(Schema.Boolean).annotate({
    description: "Void it instead: it keeps its number, and the number is never used again.",
  }),
  unvoid: Schema.optional(Schema.Boolean).annotate({
    description:
      "Take a void back: it is owed again with the number it had, or paid if its payments cover it.",
  }),
  sourceEventId: TurnEvent,
});
export const IssueResult = Schema.Struct({
  entry: Schema.String,
  number: Schema.NullOr(Schema.String),
  state: Schema.String,
  /** False when it already had its number. */
  issued: Schema.Boolean,
  /** Its documents, made again with the number, each a new version of the same doc. */
  documents: Schema.Array(
    Schema.Struct({ key: Schema.String, title: Schema.String, version: Schema.Number }),
  ),
  problems: Schema.Array(Schema.String),
  /** Said plainly when its number follows entries dated after it: tell the owner. */
  notice: Schema.optional(Schema.String),
  /** What happened, in a line: the agent has nothing to check. */
  next: Schema.optional(Schema.String),
});

/** What issuing did, so an agent asking again trusts it instead of re-checking. */
const issuedLine = (
  number: string,
  issued: boolean,
  remade: { readonly documents: ReadonlyArray<unknown>; readonly problems: ReadonlyArray<unknown> },
) => {
  const as = `${issued ? "Issued" : "Already issued"} as ${number}.`;
  if (remade.documents.length > 0)
    return `${as} Its documents were made again with the number and posted in this chat. Tell the owner the number.`;
  if (remade.problems.length > 0) return `${as} Its documents couldn't be made: see problems.`;
  return issued
    ? as
    : `${as} Its documents already carry the number; there is nothing more to make.`;
};

export const issue = leadTool("KinDocuments.issue", (lead, input: typeof IssueInput.Type) =>
  Effect.gen(function* () {
    yield* admitted(lead, "kin_issue", input);
    yield* sourceOf(lead, input.sourceEventId);
    const writer = yield* writerFor(lead);
    if (input.void === true && input.unvoid === true)
      return yield* new KinChatError({
        reason: "invalid_state",
        message: "Pass void or unvoid, not both. Nothing changed.",
      });
    const result =
      input.void === true
        ? yield* Numbers.voidEntry(lead.orgId, writer, input.entry)
        : input.unvoid === true
          ? yield* Numbers.unvoidEntry(lead.orgId, writer, input.entry)
          : yield* issueEntry(lead.orgId, writer, input.entry);
    // Asked again, it makes any of its documents that don't carry the number yet.
    const remade =
      input.void !== true &&
      input.unvoid !== true &&
      result.number !== null &&
      result.state !== "dropped"
        ? yield* remakeForEntry({
            orgId: lead.orgId,
            entryKey: result.key,
            requester: yield* requesterOf(lead, input.sourceEventId),
            admit: stillAdmitted(lead, "kin_issue", input),
          })
        : { documents: [], written: [], problems: [] };
    for (const written of remade.written) yield* shown(lead, written, true);
    return {
      entry: result.key,
      number: result.number,
      state: result.state,
      issued: result.issued,
      documents: remade.documents.map((doc) => ({
        key: doc.key,
        title: doc.title,
        version: doc.version,
      })),
      problems: remade.problems,
      ...("notice" in result && result.notice !== undefined ? { notice: result.notice } : {}),
      ...(input.void === true || input.unvoid === true || result.number === null
        ? {}
        : { next: issuedLine(result.number, result.issued, remade) }),
    };
  }),
);

export const UndoInput = Schema.Struct({
  recipe: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,39}$/)).annotate({
    description: "The recipe whose last change to undo. Undo again to redo it.",
  }),
  sourceEventId: TurnEvent,
});
export const UndoResult = Schema.Struct({
  recipe: Schema.String,
  commit: Schema.String,
  /** True when the change undone made the recipe: it is gone until undone again. */
  removed: Schema.Boolean,
  next: Schema.String,
});

const undoneLine = (recipe: string, removed: boolean) =>
  removed
    ? `Undone: the ${recipe} recipe's last change was making it, so the recipe is gone now. Undo again to bring it back.`
    : `Undone: the ${recipe} recipe is back as it was before its last change, and files made from now on use it. Undo again to redo the change.`;

export const undoRecipe = leadTool(
  "KinDocuments.undoRecipe",
  (lead, input: typeof UndoInput.Type) =>
    Effect.gen(function* () {
      yield* admitted(lead, "kin_recipe_undo", input);
      yield* sourceOf(lead, input.sourceEventId);
      const undone = yield* undoLabelled(lead.orgId, input.recipe, {
        _tag: "agent",
        agentId: lead.agentId,
      });
      if (undone._tag === "refused")
        return yield* new KinChatError({
          reason: "invalid_state",
          message: `Nothing changed: ${undone.reason}.`,
        });
      return {
        recipe: input.recipe,
        commit: undone.commit,
        removed: undone.removed,
        next: undoneLine(input.recipe, undone.removed),
      };
    }),
);

export const ReceiptInput = Schema.Struct({
  proposal: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(40))).annotate({
    description:
      "A receipt proposal this tool returned in an earlier turn: returns the receipt the owner's Confirm on its card made, with its PDF.",
  }),
  payment: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))).annotate({
    description:
      "The paymentId of a payment recorded on an invoice (payment_record returns it; record_get lists them).",
  }),
  entry: Schema.optional(KinRecordKey).annotate({
    description: "A receipt entry already made, such as an advance, to number and make again.",
  }),
  advance: Schema.optional(
    Schema.Struct({
      client: Schema.optional(KinRecordKey),
      amount: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
      receivedOn: KinDay,
    }),
  ).annotate({
    description:
      "Money received before any invoice: the client's key, the amount as the owner said it, and the day.",
  }),
  against: Schema.optional(KinRecordKey).annotate({
    description:
      "An invoice to set an advance against: Kin records it as a payment on that invoice, once.",
  }),
  towards: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(300))),
  mode: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(40))),
  reference: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(120))),
  sourceEventId: TurnEvent,
});
const ReceiptMade = Schema.Struct({
  status: Schema.Literal("made"),
  receipt: Schema.String,
  number: Schema.NullOr(Schema.String),
  documents: Schema.Array(
    Schema.Struct({ key: Schema.String, title: Schema.String, version: Schema.Number }),
  ),
  problems: Schema.Array(Schema.String),
  sensitive: Schema.Literal(true),
});
const ReceiptProposed = Schema.Struct({
  status: Schema.Literal("proposed"),
  proposal: Schema.String,
  /** What the owner's card shows, line by line. */
  shown: Schema.Array(Schema.String),
  next: Schema.String,
  sensitive: Schema.Literal(true),
});
export const ReceiptResult = Schema.Union([ReceiptMade, ReceiptProposed]);

/** `kin_receipt`: a numbered receipt and its PDF, shown as a card; asking again returns it. */
export const receipt = leadTool("KinDocuments.receipt", (lead, input: typeof ReceiptInput.Type) =>
  Effect.gen(function* () {
    yield* admitted(lead, "kin_receipt", input);
    if (yield* isOrgPaused(lead.orgId))
      return yield* denied(
        "Kin is paused by the owner, so nothing new is made until they resume it.",
      );
    const requester = yield* requesterOf(lead, input.sourceEventId);
    let request: ReceiptRequest;
    if (input.proposal !== undefined)
      request = {
        key: yield* proposalOutcome({
          orgId: lead.orgId,
          agentId: lead.agentId,
          proposalId: input.proposal,
        }),
      };
    else {
      const amount =
        input.advance === undefined
          ? undefined
          : parseAmount(
              input.advance.amount,
              yield* recordingCurrency(lead.orgId, { saved: true }),
            );
      if (amount !== undefined && "error" in amount) return yield* amount.error;
      request = {
        ...(input.payment === undefined ? {} : { paymentId: input.payment }),
        ...(input.entry === undefined ? {} : { key: input.entry }),
        ...(input.advance === undefined || amount === undefined
          ? {}
          : {
              advance: {
                ...(input.advance.client === undefined ? {} : { client: input.advance.client }),
                amount: amount.money,
                receivedOn: input.advance.receivedOn,
              },
            }),
        ...(input.against === undefined ? {} : { against: input.against }),
        ...(input.towards === undefined ? {} : { towards: input.towards }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.reference === undefined ? {} : { reference: input.reference }),
      };
      // Money received no live payment holds yet is the owner's to confirm, never the agent's.
      if (yield* createsMoney(lead.orgId, request)) {
        const chat = yield* turnChat(lead);
        if (chat === undefined) return yield* denied("This turn has no chat to ask the owner in.");
        const snapshot = yield* snapshotOf(lead.orgId, request);
        const proposal = yield* proposeReceipt({
          orgId: lead.orgId,
          agentId: lead.agentId,
          wakeupId: lead.wakeupId,
          chatId: chat.chatId,
          request,
          snapshot,
          now: yield* Clock.currentTimeMillis,
        });
        const shown = cardLines(snapshot, request);
        const card = yield* askOwner(
          lead,
          {
            chatId: chat.chatId,
            clientMessageId: `kin-receipt:${proposal}`,
            question: "Record this money as received and make its receipt?",
            detail: shown.join("\n"),
            yes: "Confirm",
            no: "Cancel",
          },
          (widgetId) => attachReceiptCard({ orgId: lead.orgId, proposalId: proposal, widgetId }),
        ).pipe(
          Effect.catchTags({
            KinChatError: (error) =>
              Effect.logWarning("Kin couldn't show a receipt card", { reason: error.reason }).pipe(
                Effect.as(undefined),
              ),
          }),
        );
        return {
          status: "proposed" as const,
          proposal,
          shown,
          next:
            card === undefined
              ? "Nothing was recorded. Kin couldn't show the owner a card to confirm this money, so ask them to record it themselves in Money."
              : "Nothing is recorded or numbered yet. Kin showed the owner this money on a card; ask in one short line to check it and tap Confirm. Their tap records it and makes its receipt; in a later turn, call kin_receipt with this proposal to read what was made.",
          sensitive: true as const,
        };
      }
    }
    const made = yield* makeReceipt({
      orgId: lead.orgId,
      writer: requester.writer,
      requester,
      paymentId: request.paymentId,
      key: request.key,
      advance:
        request.advance === undefined
          ? undefined
          : {
              client: request.advance.client,
              amount: request.advance.amount,
              receivedOn: request.advance.receivedOn,
              originKey: `receipt:advance:agent:${lead.wakeupId}`,
            },
      against: request.against,
      extras: { towards: request.towards, mode: request.mode, reference: request.reference },
      admit: stillAdmitted(lead, "kin_receipt", input),
    });
    for (const written of made.made?.written ?? []) yield* shown(lead, written, true);
    return {
      status: "made" as const,
      receipt: made.key,
      number: made.number,
      documents: (made.made?.documents ?? []).map((doc) => ({
        key: doc.key,
        title: doc.title,
        version: doc.version,
      })),
      problems: made.problems,
      sensitive: true as const,
    };
  }),
);
