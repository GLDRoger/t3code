import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { compareEntries, epochMillis, type KeeperEntry } from "./chronicle.ts";

/**
 * Live notes board. Lane 2's lineage toolkit is the durable board. This is the
 * shape the brief and the keeper read through, plus an in-memory fake.
 */
export interface Note {
  readonly id: string;
  readonly houseIds: readonly string[];
  readonly author: string;
  readonly body: string;
  readonly at: string;
  readonly flaggedMisleading: boolean;
}

export interface NoteDraft {
  readonly id: string;
  readonly houseIds: readonly string[];
  readonly author: string;
  readonly body: string;
  readonly at: string;
  readonly flaggedMisleading?: boolean;
}

export interface NotesQuery {
  readonly house?: string;
  readonly since?: string;
  readonly author?: string;
}

export interface NotesBoard {
  readonly add: (draft: NoteDraft) => Effect.Effect<Note, DuplicateNoteError>;
  readonly read: (query: NotesQuery) => Effect.Effect<readonly Note[]>;
}

export class DuplicateNoteError extends Schema.TaggedError<DuplicateNoteError>()(
  "DuplicateNoteError",
  { id: Schema.String },
) {
  override get message(): string {
    return `Note ${this.id} is already on the board.`;
  }
}

export const noteToEntry = (note: Note): KeeperEntry => ({
  id: note.id,
  kind: "note",
  at: note.at,
  body: note.body,
  houseIds: note.houseIds,
  author: note.author,
  ...(note.flaggedMisleading ? { flaggedMisleading: true } : {}),
});

const matches = (note: Note, query: NotesQuery): boolean => {
  if (query.house !== undefined && !note.houseIds.includes(query.house)) return false;
  if (query.author !== undefined && note.author !== query.author) return false;
  if (query.since !== undefined) {
    const since = epochMillis(query.since);
    const at = epochMillis(note.at);
    if (since === null || at === null || at <= since) return false;
  }
  return true;
};

export const makeInMemoryNotesBoard = Effect.fn("NotesBoard.makeInMemory")(function* () {
  const notes = yield* Ref.make<readonly Note[]>([]);

  const add = Effect.fn("NotesBoard.add")(function* (draft: NoteDraft) {
    const current = yield* Ref.get(notes);
    if (current.some((note) => note.id === draft.id)) {
      return yield* new DuplicateNoteError({ id: draft.id });
    }
    const note: Note = {
      id: draft.id,
      houseIds: draft.houseIds,
      author: draft.author,
      body: draft.body,
      at: draft.at,
      flaggedMisleading: draft.flaggedMisleading === true,
    };
    yield* Ref.set(notes, [...current, note]);
    return note;
  });

  const read = (query: NotesQuery) =>
    Ref.get(notes).pipe(
      Effect.map((current) =>
        current
          .filter((note) => matches(note, query))
          .slice()
          .sort((a, b) => compareEntries(noteToEntry(a), noteToEntry(b))),
      ),
    );

  return { add, read } satisfies NotesBoard;
});

/** Stable listing. Order is time, then id. The body is copied through. */
export const renderNotesBoard = (notes: readonly Note[]): string => {
  if (notes.length === 0) return "";
  const ordered = notes.slice().sort((a, b) => compareEntries(noteToEntry(a), noteToEntry(b)));
  const blocks = ordered.map((note) => {
    const houses = note.houseIds.slice().sort().join(", ");
    const flag = note.flaggedMisleading ? "\nflagged: misleading" : "";
    return `### ${note.id}\n${note.at}\nhouses: ${houses}\nauthor: ${note.author}${flag}\n${note.body}`;
  });
  return `## Notes board\n\n${blocks.join("\n\n")}\n`;
};
