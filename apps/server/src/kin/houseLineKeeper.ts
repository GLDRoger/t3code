import type { KeeperEntry } from "@t3tools/keeper/chronicle";
import { KeeperSource, KeeperSourceError } from "@t3tools/keeper/archivist";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const WillRow = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  at: Schema.String,
  houseId: Schema.String,
});
const NoteRow = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  at: Schema.String,
  houseId: Schema.NullOr(Schema.String),
  flaggedJson: Schema.String,
});

export function keeperEntriesFromRows(input: {
  readonly wills: readonly {
    readonly id: string;
    readonly body: string;
    readonly at: string;
    readonly houseId: string;
  }[];
  readonly notes: readonly {
    readonly id: string;
    readonly body: string;
    readonly at: string;
    readonly houseId: string | null;
    readonly flaggedJson: string;
  }[];
}): readonly KeeperEntry[] {
  const notes = new Map<string, KeeperEntry>();
  for (const note of input.notes) {
    const current = notes.get(note.id);
    const houseIds = [
      ...(current?.houseIds ?? []),
      ...(note.houseId === null ? [] : [note.houseId]),
    ];
    let flagged = false;
    try {
      const parsed = JSON.parse(note.flaggedJson) as unknown;
      flagged = Array.isArray(parsed) && parsed.length > 0;
    } catch {
      flagged = false;
    }
    notes.set(note.id, {
      id: note.id,
      kind: "note",
      at: note.at,
      body: note.body,
      ...(houseIds.length === 0 ? {} : { houseIds }),
      ...(flagged ? { flaggedMisleading: true } : {}),
    });
  }
  return [
    ...input.wills.map((will): KeeperEntry => ({
      id: will.id,
      kind: "will",
      at: will.at,
      body: will.body,
      houseIds: [will.houseId],
    })),
    ...notes.values(),
  ];
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decodeWills = Schema.decodeUnknownEffect(Schema.Array(WillRow));
  const decodeNotes = Schema.decodeUnknownEffect(Schema.Array(NoteRow));
  return KeeperSource.of({
    entries: Effect.fn("HouseLineKeeper.entries")(function* (input: { readonly scopeId: string }) {
      const projectId = input.scopeId.startsWith("repo:")
        ? input.scopeId.slice("repo:".length)
        : input.scopeId;
      const wills = yield* sql`
        SELECT w.id AS id, w.body AS body, w.written_at AS at, c.house_id AS houseId
        FROM kin_will w
        JOIN kin_crowning c ON c.id = w.crowning_id
        JOIN kin_lane l ON l.id = c.lane_id
        WHERE l.project_id = ${projectId}
        ORDER BY w.written_at ASC, w.id ASC
      `.pipe(
        Effect.flatMap(decodeWills),
        Effect.mapError((cause) => new KeeperSourceError({ scopeId: input.scopeId, cause })),
      );
      const notes = yield* sql`
        SELECT n.id AS id, n.body AS body, n.created_at AS at,
          nh.house_id AS houseId, n.flagged_misleading_by_json AS flaggedJson
        FROM kin_note n
        LEFT JOIN kin_note_house nh ON nh.note_id = n.id
        WHERE n.project_id = ${projectId}
        ORDER BY n.created_at ASC, n.id ASC
      `.pipe(
        Effect.flatMap(decodeNotes),
        Effect.mapError((cause) => new KeeperSourceError({ scopeId: input.scopeId, cause })),
      );
      return keeperEntriesFromRows({ wills, notes });
    }),
  });
});

export const layer = Layer.effect(KeeperSource, make);
