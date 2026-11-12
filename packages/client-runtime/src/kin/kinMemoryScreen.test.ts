// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import {
  KinChatError,
  KinMemoryItemId,
  KinOrgId,
  type KinMemoryConfirmSuggestionsInput,
  type KinMemoryListItem,
  type KinMemoryListResult,
  type KinMemoryVisibility,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_MEMORY_NO_EDITS,
  createKinMemoryActions,
  kinMemoryEntrySummary,
  kinMemoryStarted,
  kinMemoryView,
  type KinMemoryEdits,
} from "./kinMemoryScreen.ts";

const orgId = KinOrgId.make("invented-org");
const item = (id: string, visibility: KinMemoryVisibility, title = `Invented ${id}`) =>
  ({
    itemId: KinMemoryItemId.make(id),
    kind: "claim",
    title,
    visibility,
    from: null,
    version: `words-of-${id}`,
  }) satisfies KinMemoryListItem;
const listOf = (items: ReadonlyArray<KinMemoryListItem>) =>
  ({ items }) satisfies KinMemoryListResult;
const states = (list: KinMemoryListResult, edits: KinMemoryEdits, search = "") =>
  Object.fromEntries(
    kinMemoryView(list, edits, search).rows.flatMap((row) =>
      row.type === "item" ? [[row.item.itemId, row.item.state]] : [],
    ),
  );

/** A host whose answers the test releases one at a time. */
function harness(list: KinMemoryListResult) {
  let edits = KIN_MEMORY_NO_EDITS;
  let refreshes = 0;
  const confirmed: Array<KinMemoryConfirmSuggestionsInput> = [];
  const waiting: Array<(ok: boolean) => void> = [];
  const answer = <A>(value: () => A) =>
    new Promise<AsyncResult.Success<A> | AsyncResult.Failure<A, unknown>>((resolve) =>
      waiting.push((ok) =>
        resolve(
          ok
            ? AsyncResult.success(value())
            : AsyncResult.failure(
                Cause.fail(new KinChatError({ reason: "unavailable", message: "Down." })),
              ),
        ),
      ),
    );
  const actions = createKinMemoryActions({
    orgId,
    setVisibility: (input) =>
      answer(() => ({
        item: item(input.itemId, input.onlyOwner ? "only_owner" : "team"),
      })),
    confirmSuggestions: (input) => {
      confirmed.push(input);
      return answer(() => ({
        items: ("itemIds" in input ? input.itemIds : ["a", "b"]).map((id) => item(id, "team")),
      }));
    },
    forget: (input) => answer(() => ({ itemId: input.itemId })),
    update: (change) => {
      edits = change(edits);
    },
    refresh: () => {
      refreshes += 1;
    },
  });
  return {
    actions,
    confirmed,
    edits: () => edits,
    refreshes: () => refreshes,
    release: (ok: boolean) => waiting.shift()?.(ok),
    view: (search = "") => kinMemoryView(list, edits, search),
  };
}

describe("what the owner's leads remember", () => {
  it("lists what waits for a yes first, then the team's, then the owner's", () => {
    const view = kinMemoryView(
      listOf([item("mine", "only_owner"), item("ours", "team"), item("asked", "suggested")]),
      KIN_MEMORY_NO_EDITS,
      "",
    );
    expect(view.rows.map((row) => (row.type === "section" ? row.title : row.item.itemId))).toEqual([
      "Waiting for your yes",
      "asked",
      "The team can know",
      "ours",
      "Only you",
      "mine",
    ]);
    expect(kinMemoryEntrySummary(listOf([item("asked", "suggested")]))).toBe(
      "1 thing is waiting for your yes",
    );
  });

  it("says where each thing came from, and nothing a host or a message doesn't give", () => {
    const day = (iso: string, year = false) =>
      new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        ...(year ? { year: "numeric" as const } : {}),
      }).format(new Date(iso));
    const recordedAt = "2026-11-09T10:00:00.000Z";
    const saidAt = "2026-11-08T10:00:00.000Z";
    const told = { recordedAt, saidAt, quote: " Invoices go out on the first. " };
    const untold = { recordedAt, saidAt: null, quote: null };
    const heard = { name: "Invented Priya", chatName: "Invented room" };
    const list = listOf([
      { ...item("mine", "only_owner"), provenance: { saidBy: "boss", trust: "owner", ...told } },
      {
        ...item("theirs", "only_owner"),
        from: heard,
        provenance: { saidBy: "priya", trust: "member", ...told },
      },
      { ...item("old", "only_owner"), provenance: { saidBy: "boss", trust: "owner", ...untold } },
      // The message is gone, so its day is too.
      {
        ...item("gone", "only_owner"),
        provenance: { saidBy: "sam", trust: "member", ...untold, saidAt },
      },
      {
        ...item("guess", "only_owner"),
        provenance: { saidBy: "agent-1", trust: "agent", ...untold },
      },
      {
        ...item("retired", "only_owner"),
        provenance: { saidBy: "agent-9", trust: "agent", ...untold, recordedAt: "2025-03-02" },
      },
      {
        ...item("outside", "only_owner"),
        provenance: { saidBy: "external", trust: "external", ...untold },
      },
      { ...item("older-host", "only_owner"), from: heard },
    ]);
    const names = {
      people: [{ handle: "priya", displayName: "Priya" }],
      agents: [{ agentId: "agent-1", name: "Tech lead" }],
    };
    const view = (search = "") =>
      kinMemoryView(list, KIN_MEMORY_NO_EDITS, search, names, new Date("2026-11-11T10:00:00.000Z"));
    const shown = Object.fromEntries(
      view().rows.flatMap((row) =>
        row.type === "item" ? [[row.item.itemId, [row.item.origin, row.item.from]]] : [],
      ),
    );
    const quote = "Invoices go out on the first.";
    expect(shown).toEqual({
      mine: [{ kind: "said", line: `You said, ${day(saidAt)}`, quote }, null],
      theirs: [{ kind: "said", line: `Priya said in Invented room, ${day(saidAt)}`, quote }, null],
      old: [{ kind: "said", line: `From you, saved ${day(recordedAt)}`, quote: null }, null],
      gone: [
        { kind: "said", line: `From a teammate, saved ${day(recordedAt)}`, quote: null },
        null,
      ],
      guess: [
        { kind: "worked_out", line: `Worked out by Tech lead, ${day(recordedAt)}`, quote: null },
        null,
      ],
      retired: [
        {
          kind: "worked_out",
          line: `Worked out by an agent, ${day("2025-03-02T12:00:00", true)}`,
          quote: null,
        },
        null,
      ],
      outside: [
        { kind: "outside", line: `From outside your chats, saved ${day(recordedAt)}`, quote: null },
        null,
      ],
      "older-host": [null, "Invented Priya said this in Invented room"],
    });
    const found = (search: string) =>
      view(search).rows.flatMap((row) => (row.type === "item" ? [row.item.itemId] : []));
    expect(found("invoices")).toEqual(["mine", "theirs"]);
    expect(found("worked out")).toEqual(["guess", "retired"]);
  });

  it("names every suggestion on screen with the words shown, and only those", () => {
    const all = listOf([item("a", "suggested"), item("b", "suggested"), item("c", "team")]);
    expect(kinMemoryView(all, KIN_MEMORY_NO_EDITS, "").confirmAll?.requests).toEqual([
      { itemIds: ["a", "b"], versions: { a: "words-of-a", b: "words-of-b" } },
    ]);
    const list = listOf([
      item("a", "suggested", "Launch date"),
      item("b", "suggested", "Launch venue"),
      item("c", "suggested", "Office move"),
    ]);
    const searched = kinMemoryView(list, KIN_MEMORY_NO_EDITS, "launch").confirmAll;
    expect(searched?.requests).toEqual([
      { itemIds: ["a", "b"], versions: { a: "words-of-a", b: "words-of-b" } },
    ]);
    expect(searched?.label).toBe("Let the team know these 2");
    // Keeping one is still on its way to the host: a yes to all must not race it.
    const keeping = kinMemoryStarted(KIN_MEMORY_NO_EDITS, ["c"], "only_owner");
    expect(kinMemoryView(list, keeping, "").confirmAll?.requests).toEqual([
      { itemIds: ["a", "b"], versions: { a: "words-of-a", b: "words-of-b" } },
    ]);
  });

  it("splits a very long yes into what the host takes at once", () => {
    const many = Array.from({ length: 501 }, (_, index) => item(`s${index}`, "suggested"));
    const list = listOf([...many, item("kept", "suggested")]);
    const edits = kinMemoryStarted(KIN_MEMORY_NO_EDITS, ["kept"], "only_owner");
    expect(
      kinMemoryView(list, edits, "").confirmAll?.requests.map((request) => request.itemIds.length),
    ).toEqual([500, 1]);
  });

  it("shows a tap at once, takes it back when the host refuses, and reads again once idle", async () => {
    const list = listOf([item("a", "suggested"), item("b", "suggested")]);
    const host = harness(list);
    const kept = host.actions.change(list, KinMemoryItemId.make("a"), "only_owner");
    const shared = host.actions.change(list, KinMemoryItemId.make("b"), "team");
    expect(states(list, host.edits())).toEqual({ a: "only_owner", b: "team" });
    expect(host.view().rows.flatMap((row) => (row.type === "item" ? [row.item.busy] : []))).toEqual(
      [true, true],
    );

    host.release(false);
    await kept;
    expect(states(list, host.edits())).toEqual({ a: "suggested", b: "team" });
    expect(host.edits().problem).toBe("Couldn't change that. Try again.");
    expect(host.refreshes()).toBe(0);

    host.release(true);
    await shared;
    expect(states(list, host.edits())).toEqual({ a: "suggested", b: "team" });
    expect(host.refreshes()).toBe(1);
    // The host's next list is the truth; an answer made over the old one no longer covers it.
    expect(states(listOf([item("a", "suggested"), item("b", "only_owner")]), host.edits())).toEqual(
      { a: "suggested", b: "only_owner" },
    );
  });

  it("drops a forgotten item at once and puts it back when the host refuses", async () => {
    const list = listOf([item("a", "only_owner"), item("b", "team")]);
    const host = harness(list);
    const refused = host.actions.forget(list, KinMemoryItemId.make("a"));
    expect(states(list, host.edits())).toEqual({ b: "team" });
    expect(host.view().total).toBe(1);
    host.release(false);
    await refused;
    expect(states(list, host.edits())).toEqual({ a: "only_owner", b: "team" });
    expect(host.edits().problem).toBe("Couldn't change that. Try again.");

    const forgotten = host.actions.forget(list, KinMemoryItemId.make("a"));
    host.release(true);
    await forgotten;
    // Gone until the host's next list, which no longer holds it.
    expect(states(list, host.edits())).toEqual({ b: "team" });
  });

  it("never sends a yes for a row that doesn't say which words it showed", async () => {
    const { version: _version, ...unversioned } = item("a", "suggested");
    const list = listOf([unversioned]);
    const host = harness(list);
    const tapped = host.actions.change(list, KinMemoryItemId.make("a"), "team");
    host.release(true);
    await tapped;
    expect(states(list, host.edits())).toEqual({ a: "suggested" });
    expect(host.edits().problem).toBe("Couldn't change that. Try again.");
    expect(host.refreshes()).toBe(1);
  });

  it("says yes to all with the words the owner saw and rolls back if it fails", async () => {
    const list = listOf([item("a", "suggested"), item("b", "suggested")]);
    const host = harness(list);
    const all = host.view().confirmAll;
    if (all === null) throw new Error("Expected suggestions to confirm.");
    const failed = host.actions.confirmAll(list, all);
    expect(states(list, host.edits())).toEqual({ a: "team", b: "team" });
    host.release(false);
    await failed;
    expect(states(list, host.edits())).toEqual({ a: "suggested", b: "suggested" });

    const done = host.actions.confirmAll(list, all);
    host.release(true);
    await done;
    const shown = { itemIds: ["a", "b"], versions: { a: "words-of-a", b: "words-of-b" } };
    expect(host.confirmed).toEqual([
      { orgId, ...shown },
      { orgId, ...shown },
    ]);
    expect(states(list, host.edits())).toEqual({ a: "team", b: "team" });
  });
});
