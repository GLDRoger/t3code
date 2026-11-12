import { KinChatError, type KinOrgId, type KinPersonId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { Recipe, Value } from "./recipe.ts";
import { KinDocRenderer } from "./render.ts";
import {
  type ChangedBy,
  KinWorkspace,
  type RecipeChange,
  type Revision,
  type StoredRecipe,
  type VerifyChange,
} from "./workspace.ts";

// A recipe revision's label is the server's: sensitive when the job that wrote it was, or when the
// revision it was built on is. Every document made from it carries it; only the owner clears it.

const SAMPLE_DAY = "2026-01-01";
/** A recipe's sample.json as its inputs: each declared input's value, or null. */
export const sampleInputs = (
  recipe: Recipe,
  sample: string | undefined,
): Readonly<Record<string, Value>> | string => {
  if (sample === undefined)
    return "it has no sample.json: invented values for every input, so Kin can render it";
  let parsed: unknown;
  try {
    parsed = JSON.parse(sample);
  } catch {
    return "its sample.json isn't JSON";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return "its sample.json isn't an object of inputs";
  return Object.fromEntries(
    recipe.inputs.map((input) => [input.name, (Reflect.get(parsed, input.name) ?? null) as Value]),
  );
};

/** Why a recipe can't be kept: its sample, rendered as Kin renders a document from it. */
export const verifySample =
  (renderer: KinDocRenderer["Service"], orgId: KinOrgId): VerifyChange =>
  ({ commit, recipe, sample }) =>
    Effect.gen(function* () {
      const inputs = sampleInputs(recipe, sample);
      if (typeof inputs === "string") return inputs;
      const rendered = yield* renderer.render({
        orgId,
        recipe,
        commit,
        inputs,
        day: typeof inputs.today === "string" ? inputs.today : SAMPLE_DAY,
      });
      return rendered._tag === "made" ? undefined : rendered.reason;
    }).pipe(Effect.catch((error) => Effect.succeed(error.message)));

/** A revision's label: its own row, else, from before Kin kept rows, the job that wrote it. */
const revisionLabelled = Effect.fn("KinRecipeLabels.revision")(function* (
  orgId: KinOrgId,
  recipe: string,
  revision: Revision,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ sensitive: number }>`SELECT sensitive FROM kin_recipe_labels
    WHERE org_id = ${orgId} AND recipe = ${recipe} AND commit_sha = ${revision.commit}
    ORDER BY commit_sha`;
  if (row !== undefined) return row.sensitive === 1;
  if (revision.workerId === null) return false;
  const [job] = yield* sql<{ sensitive: number }>`SELECT sensitive FROM kin_doc_jobs
    WHERE org_id = ${orgId} AND worker_id = ${revision.workerId} AND mode = 'recipe'
    ORDER BY worker_id`;
  return job?.sensitive === 1;
});

/** Whether documents made from the recipe as it is now are labelled because of how it was written. */
export const recipeLabelled = (orgId: KinOrgId, recipe: StoredRecipe) =>
  revisionLabelled(orgId, recipe.name, {
    commit: recipe.commit,
    workerId: recipe.changed._tag === "agent" ? recipe.changed.workerId : null,
  });

const label = Effect.fn("KinRecipeLabels.label")(function* (
  orgId: KinOrgId,
  recipe: string,
  commits: ReadonlyArray<string>,
  sensitive: boolean,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  for (const commit of new Set(commits))
    yield* sql`INSERT INTO kin_recipe_labels (org_id, recipe, commit_sha, sensitive, labelled_at)
      VALUES (${orgId}, ${recipe}, ${commit}, ${sensitive ? 1 : 0}, ${now})
      ON CONFLICT (org_id, recipe, commit_sha) DO UPDATE SET
        sensitive = MAX(sensitive, excluded.sensitive)`;
});

/** A committed change's label: its job's, or carried from a revision it was built on. */
export const labelChange = Effect.fn("KinRecipeLabels.change")(function* (
  orgId: KinOrgId,
  recipe: string,
  change: Extract<RecipeChange, { readonly _tag: "committed" }>,
  jobSensitive: boolean,
) {
  let sensitive = jobSensitive;
  for (const revision of change.builtOn)
    sensitive = sensitive || (yield* revisionLabelled(orgId, recipe, revision));
  yield* label(orgId, recipe, [change.commit, change.revision], sensitive);
  return sensitive;
});

/** Undoes a recipe's last change once what it brings back renders; the undo takes that one's label. */
export const undoRecipe = Effect.fn("KinRecipeLabels.undo")(function* (
  orgId: KinOrgId,
  name: string,
  by: ChangedBy,
) {
  const renderer = yield* KinDocRenderer;
  const undone = yield* (yield* KinWorkspace).undoRecipe(
    orgId,
    name,
    by,
    verifySample(renderer, orgId),
  );
  if (undone._tag === "undone")
    yield* label(
      orgId,
      name,
      [undone.commit],
      undone.restored !== null && (yield* revisionLabelled(orgId, name, undone.restored)),
    );
  return undone;
});

/** The owner clears a recipe's label as it is now; later changes start from that. */
export const clearLabel = Effect.fn("KinRecipeLabels.clear")(function* (
  orgId: KinOrgId,
  name: string,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const recipe = (yield* (yield* KinWorkspace).recipes(orgId)).find((one) => one.name === name);
  if (recipe === undefined)
    return yield* new KinChatError({ reason: "not_found", message: `There is no recipe ${name}.` });
  const now = yield* Clock.currentTimeMillis;
  yield* sql`INSERT INTO kin_recipe_labels (org_id, recipe, commit_sha, sensitive,
      cleared_by_person_id, labelled_at)
    VALUES (${orgId}, ${name}, ${recipe.commit}, 0, ${personId}, ${now})
    ON CONFLICT (org_id, recipe, commit_sha) DO UPDATE SET sensitive = 0,
      cleared_by_person_id = excluded.cleared_by_person_id, labelled_at = excluded.labelled_at`;
  return { recipe: name, commit: recipe.commit };
});
