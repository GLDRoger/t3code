import { KinChatError, KinPersonId, KinRecordKey, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { isOrgPaused } from "../lead/orgState.ts";
import { toolAdmitted } from "../lead/SharedTools.ts";
import { shown } from "../work/leadDocs.ts";
import { admitted, askedBy, type Lead, leadTool, sourceOf, writerFor } from "../work/leadWork.ts";
import type { DocumentInput } from "./DocJobs.ts";
import { canonical, makeDocument, remakeForEntry, type Requester } from "./make.ts";
import * as Numbers from "./numbering.ts";
import { recipeLabelled, undoRecipe as undoLabelled } from "./recipeLabels.ts";
import { KinWorkspace } from "./workspace.ts";

/** `kin_recipes`, `kin_issue`, `kin_recipe_undo`, and `kin_document` with a recipe, made in the call. */

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
    }),
  ),
});

export const recipes = leadTool("KinDocuments.recipes", (lead, _input: Record<string, never>) =>
  Effect.gen(function* () {
    yield* admitted(lead, "kin_recipes", {});
    const stored = yield* (yield* KinWorkspace).recipes(lead.orgId);
    const labelled = yield* Effect.forEach(stored, (recipe) => recipeLabelled(lead.orgId, recipe));
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
