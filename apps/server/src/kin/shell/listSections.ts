import type { KinOrgId, KinShell as Shell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { listDef } from "../work/registers.ts";
import { allSeeMoney, seenBy, teamLists, type KinViewer } from "../work/teamView.ts";
import { getForDisplay, listOfSection } from "./KinShell.ts";
import type { ListShown } from "./words.ts";

/**
 * The lists among `ids` this viewer reaches as Lists shows them (`ownerMoney.lists`): live, and for
 * a teammate not sensitive, and either a team list or one with Money on and an entry they see.
 */
export const listsSeen = Effect.fn("KinShell.listsSeen")(function* (
  orgId: KinOrgId,
  ids: ReadonlyArray<string>,
  viewer: KinViewer,
) {
  if (ids.length === 0) return new Set<string>();
  const sql = yield* SqlClient.SqlClient;
  const live = yield* sql<{ id: string; sensitive: number }>`SELECT register_id AS id,
      json_type(definition_json, '$.sensitive') = 'true' AS sensitive
    FROM kin_registers WHERE org_id = ${orgId} AND built_in = 0 AND archived_at IS NULL
      AND register_id IN ${sql.in(ids)} ORDER BY register_id`;
  if (viewer._tag === "ownerLevel") return new Set(live.map((row) => row.id));
  const open = live.filter((row) => row.sensitive !== 1).map((row) => row.id);
  if (open.length === 0) return new Set<string>();
  const team = yield* teamLists(orgId);
  const money = yield* allSeeMoney(orgId, viewer.people);
  const entries = money
    ? yield* sql<{ id: string }>`SELECT DISTINCT r.register_id AS id FROM kin_records r
        WHERE r.org_id = ${orgId} AND r.register_id IN ${sql.in(open)} AND ${seenBy(sql, viewer)}
        ORDER BY r.register_id`
    : [];
  const seen = new Set(entries.map((row) => row.id));
  return new Set(open.filter((id) => team.has(id) || seen.has(id)));
});

/** The shell as this viewer reads it: a list section they don't reach, or an archived list's, is left out. */
export const shellFor = Effect.fn("KinShell.shellFor")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
) {
  const shell: Shell = yield* getForDisplay(orgId);
  const ids = shell.sections.flatMap((section) => listOfSection(section.id) ?? []);
  if (ids.length === 0) return shell;
  const seen = yield* listsSeen(orgId, ids, viewer).pipe(
    Effect.catch(() =>
      Effect.logWarning("Kin couldn't read who sees the list sections; leaving them out.", {
        orgId,
      }).pipe(Effect.as(new Set<string>())),
    ),
  );
  return {
    ...shell,
    sections: shell.sections.filter((section) => {
      const list = listOfSection(section.id);
      return list === undefined || seen.has(list);
    }),
  };
});

/** The list sections switched on that this viewer reaches, as an agent's prompt names them. */
export const listSectionsShown = Effect.fn("KinShell.listSectionsShown")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
) {
  const shell = yield* shellFor(orgId, viewer);
  const ids = shell.sections.flatMap((section) =>
    section.on ? (listOfSection(section.id) ?? []) : [],
  );
  const defs = yield* Effect.forEach(ids, (id) => listDef(orgId, id));
  return defs.flatMap((def): ReadonlyArray<ListShown> => {
    if (def === undefined) return [];
    const other = def.check?.below ?? def.check?.above;
    return [
      {
        id: def.id,
        name: def.name,
        fields: def.fields
          .filter((one) => one.retired !== true)
          .map((one) => ({ key: one.key, type: one.type })),
        states: def.states.map((state) => ({ state, label: def.stateLabels[state] })),
        ...(def.check === undefined || other === undefined
          ? {}
          : {
              check: {
                field: def.check.field,
                side: def.check.below === undefined ? "above" : "below",
                other: String(other),
              },
            }),
        ...(def.remindOn === undefined ? {} : { remindOn: def.remindOn }),
      },
    ];
  });
});
