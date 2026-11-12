import { KinRecordKey, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { admitted, leadTool, sourceOf, writerFor } from "../work/leadWork.ts";
import * as Numbers from "./numbering.ts";
import { KinWorkspace } from "./workspace.ts";

/** `kin_recipes` and `kin_issue`: what an agent reads and does before it asks for a document. */

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
      list: Schema.NullOr(Schema.String),
      numbered: Schema.Boolean,
      /** Starts only from an owner-only turn, and makes a sensitive doc. */
      confidential: Schema.Boolean,
      inputs: Schema.Array(RecipeInputRow),
      outputs: Schema.Array(Schema.String),
    }),
  ),
});

export const recipes = leadTool("KinDocuments.recipes", (lead, _input: Record<string, never>) =>
  Effect.gen(function* () {
    yield* admitted(lead, "kin_recipes", {});
    const stored = yield* (yield* KinWorkspace).recipes(lead.orgId);
    return {
      recipes: stored.map((recipe) => ({
        name: recipe.name,
        title: recipe.title,
        description: recipe.description,
        list: recipe.list,
        numbered: recipe.numbered,
        confidential: recipe.sensitive,
        inputs: recipe.inputs.map((input) => ({
          name: input.name,
          type: input.type,
          from: input.from,
          required: input.required,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.type === "table" ? { columns: Object.keys(input.columns) } : {}),
        })),
        outputs: [...recipe.outputs],
      })),
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
    return { entry: result.key, number: result.number, state: result.state, issued: result.issued };
  }),
);
