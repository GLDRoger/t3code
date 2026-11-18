import { KinPersonId, type KinRecordComment } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinTaskNoteThread } from "./kinTaskNotes";

const rhea = { _tag: "person", personId: KinPersonId.make("rhea") } as const;
const note = (seq: number, extra: Partial<KinRecordComment> = {}): KinRecordComment => ({
  commentId: `c${seq}`,
  seq,
  at: `2026-11-0${Math.min(seq, 9)}T09:00:00.000Z`,
  by: rhea,
  body: `Invented note ${seq}`,
  files: [],
  ...extra,
});
const removed = (seq: number) =>
  note(seq, { body: "", removed: { at: "2026-11-10T09:00:00.000Z", by: rhea } });
const seqs = (comments: ReadonlyArray<KinRecordComment>) =>
  comments.map((one) => `${one.seq}${one.removed === undefined ? "" : "x"}`).join(",");

describe("kinTaskNoteThread", () => {
  it.each([
    ["the sheet alone", { sheet: [note(3), note(4)], sheetOlder: true }, "3,4", true],
    [
      "an earlier page goes first and says whether more are left",
      {
        sheet: [note(3), note(4)],
        sheetOlder: true,
        earlier: { comments: [note(1), note(2)], more: false },
      },
      "1,2,3,4",
      false,
    ],
    [
      "an earlier page that overlaps a newer sheet keeps one of each",
      {
        sheet: [note(2), note(3)],
        sheetOlder: true,
        earlier: { comments: [note(1), note(2)], more: true },
      },
      "1,2,3",
      true,
    ],
    [
      "a note posted here shows before the sheet carries it, and once after",
      { sheet: [note(1)], sheetOlder: false, posted: [note(2)] },
      "1,2",
      false,
    ],
    [
      "a posted note the sheet now carries is not doubled",
      { sheet: [note(1), note(2)], sheetOlder: false, posted: [note(2)] },
      "1,2",
      false,
    ],
    [
      "a removal answer marks the note before the sheet is read again",
      { sheet: [note(1), note(2)], sheetOlder: false, answers: [removed(1)] },
      "1x,2",
      false,
    ],
    [
      "a removal answer reaches an earlier page too",
      {
        sheet: [note(2)],
        sheetOlder: true,
        earlier: { comments: [note(1)], more: false },
        answers: [removed(1)],
      },
      "1x,2",
      false,
    ],
  ] as const)("%s", (_name, input, expected, more) => {
    const thread = kinTaskNoteThread({
      earlier: null,
      posted: [],
      answers: [],
      ...input,
    });
    expect(seqs(thread.comments)).toBe(expected);
    expect(thread.more).toBe(more);
  });
});
