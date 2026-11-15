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
import { KinRecords } from "../work/KinRecords.ts";
import { askOwner } from "../work/leadMoney.ts";
import { dayIn, formatMoney, parseAmount } from "../work/money.ts";
import { ownerZone } from "../work/recordRows.ts";
import { admitted, askedBy, type Lead, leadTool, sourceOf, writerFor } from "../work/leadWork.ts";
import type { DocumentInput } from "./DocJobs.ts";
import { canonical, makeDocument, remakeForEntry, type Requester } from "./make.ts";
import * as Numbers from "./numbering.ts";
import {
  attachReceiptCard,
  confirmedReceipt,
  markReceiptMade,
  proposeReceipt,
  type ReceiptRequest,
} from "./receiptProposals.ts";
import { createsMoney, makeReceipt } from "./receipts.ts";
import { defaultRecipes } from "./recipeDefaults.ts";
import { recipeLabelled, undoRecipe as undoLabelled } from "./recipeLabels.ts";
import { KinWorkspace } from "./workspace.ts";

/**
 * `kin_recipes`, `kin_issue`, `kin_recipe_undo`, `kin_receipt`, and `kin_document` with a recipe,
 * made in the call.
 */

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

/** The agent as a requester: its turn, the chat it answers in and the owner's message there. */
const requesterOf = Effect.fn("KinDocuments.requester")(function* (
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
const stillAdmitted = (lead: Lead, tool: string, args: unknown) =>
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
    const made = yield* makeDocument({
      orgId: lead.orgId,
      recipe: input.recipe!,
      entry: input.entry,
      given: input.inputs ?? {},
      title: input.title,
      requester,
      jobKey: `agent:${lead.wakeupId}:${input.sourceEventId}:${input.recipe}:${input.entry ?? ""}:${input.title}:${canonical(input.inputs ?? {})}`,
      admit: stillAdmitted(lead, "kin_document", input),
    });
    for (const written of made.written) yield* shown(lead, written, true);
    return {
      workerId: null,
      threadLink: null,
      recipe: made.recipe,
      number: made.number,
      draft: made.draft,
      documents: made.documents.map((doc) => ({
        key: doc.key,
        title: doc.title,
        version: doc.version,
      })),
      ...(made.sensitive ? { sensitive: true as const } : {}),
    };
  }),
);

export const IssueInput = Schema.Struct({
  entry: KinRecordKey.annotate({
    description: "The draft to issue or the entry to void, such as INV-12.",
  }),
  void: Schema.optional(Schema.Boolean).annotate({
    description: "Void it instead: it keeps its number, and the number is never used again.",
  }),
  sourceEventId: TrimmedNonEmptyString,
});
export const IssueResult = Schema.Struct({
  entry: Schema.String,
  number: Schema.NullOr(Schema.String),
  state: Schema.String,
  /** False when it already had its number: asking again changes nothing. */
  issued: Schema.Boolean,
  /** Its documents, made again with the number, each a new version of the same doc. */
  documents: Schema.Array(
    Schema.Struct({ key: Schema.String, title: Schema.String, version: Schema.Number }),
  ),
  problems: Schema.Array(Schema.String),
});

export const issue = leadTool("KinDocuments.issue", (lead, input: typeof IssueInput.Type) =>
  Effect.gen(function* () {
    yield* admitted(lead, "kin_issue", input);
    yield* sourceOf(lead, input.sourceEventId);
    const writer = yield* writerFor(lead);
    const result =
      input.void === true
        ? yield* Numbers.voidEntry(lead.orgId, writer, input.entry)
        : yield* Numbers.issue(lead.orgId, writer, input.entry);
    // Asked again, it makes any of its documents that don't carry the number yet.
    const remade =
      input.void !== true && result.number !== null && result.state !== "dropped"
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
    };
  }),
);

export const UndoInput = Schema.Struct({
  recipe: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,39}$/)).annotate({
    description: "The recipe whose last change to undo. Undo again to redo it.",
  }),
  sourceEventId: TrimmedNonEmptyString,
});
export const UndoResult = Schema.Struct({
  recipe: Schema.String,
  commit: Schema.String,
  /** True when the change undone made the recipe: it is gone until undone again. */
  removed: Schema.Boolean,
});

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
      return { recipe: input.recipe, commit: undone.commit, removed: undone.removed };
    }),
);

export const ReceiptInput = Schema.Struct({
  proposal: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(40))).annotate({
    description:
      "A receipt proposal this tool returned in an earlier turn, once the owner tapped Confirm on its card: makes exactly that receipt.",
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
  sourceEventId: TrimmedNonEmptyString,
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
});
export const ReceiptResult = Schema.Union([ReceiptMade, ReceiptProposed]);

/** What the owner's card shows for a receipt that records money: who, how much, when, how. */
const receiptLines = Effect.fn("KinDocuments.receiptLines")(function* (
  lead: Lead,
  request: ReceiptRequest,
) {
  const records = yield* KinRecords;
  const zone = yield* ownerZone(lead.orgId);
  const entry = request.key === undefined ? undefined : yield* records.get(lead.orgId, request.key);
  const clientKey = request.advance?.client;
  const client =
    clientKey !== undefined
      ? yield* records.get(lead.orgId, clientKey)
      : entry?.partyId == null
        ? undefined
        : yield* records.getById(lead.orgId, entry.partyId);
  const amount =
    request.advance?.amount ??
    (entry?.amountMinor == null || entry.currency === null
      ? undefined
      : { minor: entry.amountMinor, currency: entry.currency });
  const day =
    request.advance?.receivedOn ?? (entry?.dateAt == null ? undefined : dayIn(entry.dateAt, zone));
  const towards = request.towards ?? (request.advance === undefined ? undefined : "Advance");
  return [
    `Client: ${client === undefined ? "none named" : `${client.title} (${client.key})`}`,
    `Amount: ${amount === undefined ? "none given" : formatMoney(amount)}`,
    `Received on: ${day ?? "no day given"}`,
    `Mode: ${request.mode ?? "not given"}${request.reference === undefined ? "" : `, ref ${request.reference}`}`,
    ...(entry === undefined ? [] : [`Receipt entry: ${entry.key}`]),
    ...(towards === undefined ? [] : [`Towards: ${towards}`]),
    `Set against: ${request.against ?? "no invoice; it stays an advance"}`,
  ];
});

/** `kin_receipt`: a numbered receipt and its PDF, shown as a card; asking again returns it. */
export const receipt = leadTool("KinDocuments.receipt", (lead, input: typeof ReceiptInput.Type) =>
  Effect.gen(function* () {
    yield* admitted(lead, "kin_receipt", input);
    if (yield* isOrgPaused(lead.orgId))
      return yield* denied(
        "Kin is paused by the owner, so nothing new is made until they resume it.",
      );
    const requester = yield* requesterOf(lead, input.sourceEventId);
    const confirmed =
      input.proposal === undefined
        ? undefined
        : yield* confirmedReceipt({
            orgId: lead.orgId,
            agentId: lead.agentId,
            proposalId: input.proposal,
          });
    let request: ReceiptRequest;
    if (confirmed?._tag === "made") request = { key: confirmed.key };
    else if (confirmed?._tag === "confirmed") request = confirmed.request;
    else {
      const amount =
        input.advance === undefined ? undefined : parseAmount(input.advance.amount, "INR");
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
        const proposal = yield* proposeReceipt({
          orgId: lead.orgId,
          agentId: lead.agentId,
          wakeupId: lead.wakeupId,
          chatId: chat.chatId,
          request,
          now: yield* Clock.currentTimeMillis,
        });
        const shown = yield* receiptLines(lead, request);
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
              : "Nothing is recorded or numbered yet. Kin showed the owner this money on a card; ask in one short line to check it and tap Confirm. Once they tap Confirm, call kin_receipt with this proposal (and a sourceEventId) in that later turn.",
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
              originKey: `receipt:advance:proposal:${input.proposal}`,
            },
      against: request.against,
      extras: { towards: request.towards, mode: request.mode, reference: request.reference },
      admit: stillAdmitted(lead, "kin_receipt", input),
    });
    if (confirmed?._tag === "confirmed")
      yield* markReceiptMade({
        orgId: lead.orgId,
        proposalId: input.proposal!,
        key: made.key,
        now: yield* Clock.currentTimeMillis,
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
