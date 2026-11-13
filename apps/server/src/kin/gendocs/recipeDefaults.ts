import { KinChatError, type KinOrgId, type KinPersonId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KinWorkspace, type StoredRecipe } from "./workspace.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";

/**
 * The names of the recipes each list makes its documents with unless another is picked: the one
 * the owner chose while it still makes that list's, else the first whose front matter says so.
 */
export const defaultRecipes = Effect.fn("KinRecipeDefaults.read")(function* (
  orgId: KinOrgId,
  recipes: ReadonlyArray<StoredRecipe>,
) {
  const sql = yield* SqlClient.SqlClient;
  const chosen = yield* sql<{ list: string; recipe: string }>`SELECT list, recipe
    FROM kin_recipe_defaults WHERE org_id = ${orgId} ORDER BY list`;
  const byList = new Map<string, string>();
  for (const recipe of recipes)
    if (recipe.list !== null && recipe.default && !byList.has(recipe.list))
      byList.set(recipe.list, recipe.name);
  for (const one of chosen)
    if (recipes.some((recipe) => recipe.name === one.recipe && recipe.list === one.list))
      byList.set(one.list, one.recipe);
  return new Set(byList.values());
});

/** The owner makes a recipe the one its list uses. */
export const setDefaultRecipe = Effect.fn("KinRecipeDefaults.set")(function* (
  orgId: KinOrgId,
  name: string,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const recipe = (yield* (yield* KinWorkspace).recipes(orgId)).find((one) => one.name === name);
  if (recipe === undefined)
    return yield* new KinChatError({ reason: "not_found", message: `There is no recipe ${name}.` });
  if (recipe.list === null)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `The ${name} recipe isn't made for a list's entries, so it can't be a list's default.`,
    });
  const now = yield* Clock.currentTimeMillis;
  yield* sql`INSERT INTO kin_recipe_defaults (org_id, list, recipe, set_by_person_id, set_at)
    VALUES (${orgId}, ${recipe.list}, ${name}, ${personId}, ${now})
    ON CONFLICT (org_id, list) DO UPDATE SET recipe = excluded.recipe,
      set_by_person_id = excluded.set_by_person_id, set_at = excluded.set_at`;
  yield* (yield* KinRefreshObserver).touch(orgId, "recipes");
  return { list: recipe.list, recipe: name };
});
