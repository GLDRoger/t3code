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
const listOf = (items: ReadonlyArray<KinMemoryListItem>, suggestionsAsOf = 7) =>
  ({ items, suggestionsAsOf }) satisfies KinMemoryListResult;
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

  it("confirms everything shown as of the list the owner saw", () => {
    const list = listOf([item("a", "suggested"), item("b", "suggested"), item("c", "team")], 12);
    expect(kinMemoryView(list, KIN_MEMORY_NO_EDITS, "").confirmAll?.requests).toEqual([
      { asOf: 12 },
    ]);
  });

  it("names the items instead when a search or a kept suggestion narrows what is on screen", () => {
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
      kinMemoryView(list, edits, "").confirmAll?.requests.map((request) =>
        "itemIds" in request ? request.itemIds.length : request,
      ),
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

  it("says yes to all with the revision the owner saw and rolls back if it fails", async () => {
    const list = listOf([item("a", "suggested"), item("b", "suggested")], 31);
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
    expect(host.confirmed).toEqual([
      { orgId, asOf: 31 },
      { orgId, asOf: 31 },
    ]);
    expect(states(list, host.edits())).toEqual({ a: "team", b: "team" });
  });
});
