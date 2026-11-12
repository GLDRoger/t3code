import { KinChatError, type KinOrgId, type KinPersonId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { readProfile } from "../work/companyProfile.ts";
import { logoFile, logoPath } from "./brand.ts";
import { checkedSample, type Recipe, type Value } from "./recipe.ts";
import { KinDocRenderer, type Rendered } from "./render.ts";
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
  const checked = checkedSample(recipe, parsed);
  return "error" in checked
    ? `its sample.json has inputs that aren't right: ${checked.error}`
    : checked.inputs;
};

/** A stand-in logo for a sample when the company has none yet: a plain mark, no text. */
const PLACEHOLDER_LOGO = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80" viewBox="0 0 240 80"><rect width="240" height="80" rx="10" fill="#94a3b8"/><rect x="18" y="18" width="44" height="44" rx="22" fill="#e2e8f0"/><rect x="76" y="30" width="140" height="20" rx="6" fill="#e2e8f0"/></svg>',
);
export type SampleLogo = { readonly bytes: Uint8Array; readonly extension: string };

/** The logo a sample renders with: the company's, else the stand-in. */
export const sampleLogo = Effect.fn("KinRecipeLabels.sampleLogo")(function* (orgId: KinOrgId) {
  const profile = yield* readProfile(orgId);
  const own = profile.logo === null ? null : yield* logoFile(profile.logo);
  return own ?? { bytes: PLACEHOLDER_LOGO, extension: "svg" };
});

/** A recipe's sample rendered as Kin renders a document from it, or why it can't be. */
export const renderSample: (
  renderer: KinDocRenderer["Service"],
  orgId: KinOrgId,
  logo: SampleLogo,
  change: Parameters<VerifyChange>[0],
  page?: boolean,
) => Effect.Effect<Extract<Rendered, { readonly _tag: "made" }> | string> = Effect.fn(
  "KinRecipeLabels.renderSample",
)(
  function* (renderer, orgId, logo, change, page = false) {
    const given = sampleInputs(change.recipe, change.sample);
    if (typeof given === "string") return given;
    // A sample that shows a logo shows the company's own, at the path Kin puts it.
    const logoInputs = change.recipe.inputs.filter((input) => input.from === "company.logo");
    const shown = logoInputs.some((input) => given[input.name] != null);
    const inputs = {
      ...given,
      ...Object.fromEntries(
        logoInputs.map((input) => [input.name, shown ? logoPath(logo.extension) : null]),
      ),
    };
    const rendered = yield* renderer.render({
      orgId,
      recipe: change.recipe,
      commit: change.commit,
      inputs,
      day: typeof inputs.today === "string" ? inputs.today : SAMPLE_DAY,
      logo: shown ? logo : null,
      page,
    });
    return rendered._tag === "made" ? rendered : rendered.reason;
  },
  Effect.catch((error) => Effect.succeed(error.message)),
);

/** Why a recipe can't be kept: its sample, rendered as Kin renders a document from it. */
export const verifySample =
  (renderer: KinDocRenderer["Service"], orgId: KinOrgId, logo: SampleLogo): VerifyChange =>
  (change) =>
    renderSample(renderer, orgId, logo, change).pipe(
      Effect.map((rendered) =>
        typeof rendered === "string" ? `its sample didn't render: ${rendered}` : undefined,
      ),
    );

/**
 * Where `main` was before Kin's first change that labels as it commits, recorded before that
 * change commits: every later commit gets its row once it is visible, unless a crash came between.
 */
export const recordBaseline = Effect.fn("KinRecipeLabels.baseline")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [known] = yield* sql`SELECT 1 AS known FROM kin_recipe_label_baselines
    WHERE org_id = ${orgId}`;
  if (known !== undefined) return;
  const head = yield* (yield* KinWorkspace).head(orgId);
  const now = yield* Clock.currentTimeMillis;
  yield* sql`INSERT INTO kin_recipe_label_baselines (org_id, commit_sha, recorded_at)
    VALUES (${orgId}, ${head}, ${now}) ON CONFLICT (org_id) DO NOTHING`;
});

/**
 * A revision's label: its own row; else sensitive when it came after the baseline, since its row
 * was lost between its commit and its label; else, from before Kin kept rows, the job that wrote it.
 */
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
  const [baseline] = yield* sql<{ commit: string }>`SELECT commit_sha AS "commit"
    FROM kin_recipe_label_baselines WHERE org_id = ${orgId}`;
  if (
    baseline !== undefined &&
    !(yield* (yield* KinWorkspace).madeBefore(orgId, revision.commit, baseline.commit))
  )
    return true;
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
  yield* recordBaseline(orgId);
  const undone = yield* (yield* KinWorkspace).undoRecipe(
    orgId,
    name,
    by,
    verifySample(renderer, orgId, yield* sampleLogo(orgId)),
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

/** The owner clears a recipe's label as they saw it; later changes start from that. */
export const clearLabel = Effect.fn("KinRecipeLabels.clear")(function* (
  orgId: KinOrgId,
  name: string,
  personId: KinPersonId,
  seen: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const recipe = (yield* (yield* KinWorkspace).recipes(orgId)).find((one) => one.name === name);
  if (recipe === undefined)
    return yield* new KinChatError({ reason: "not_found", message: `There is no recipe ${name}.` });
  if (recipe.commit !== seen)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `The ${name} recipe changed after you looked at it. Look at it again, then clear its label.`,
    });
  const now = yield* Clock.currentTimeMillis;
  yield* sql`INSERT INTO kin_recipe_labels (org_id, recipe, commit_sha, sensitive,
      cleared_by_person_id, labelled_at)
    VALUES (${orgId}, ${name}, ${recipe.commit}, 0, ${personId}, ${now})
    ON CONFLICT (org_id, recipe, commit_sha) DO UPDATE SET sensitive = 0,
      cleared_by_person_id = excluded.cleared_by_person_id, labelled_at = excluded.labelled_at`;
  return { recipe: name, commit: recipe.commit };
});
