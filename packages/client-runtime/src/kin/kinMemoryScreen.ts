import {
  KIN_MEMORY_CONFIRM_MAX,
  KinChatError,
  type KinMemoryConfirmSuggestionsInput,
  type KinMemoryConfirmSuggestionsResult,
  type KinMemoryForgetInput,
  type KinMemoryForgetResult,
  type KinMemoryItemId,
  type KinMemoryListItem,
  type KinMemoryListResult,
  type KinMemorySetVisibilityInput,
  type KinMemorySetVisibilityResult,
  type KinMemoryVisibility,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";

export const KIN_MEMORY_TITLE = "Memory";
export const KIN_MEMORY_SEARCH_PLACEHOLDER = "Search what they remember";
export const KIN_MEMORY_LOAD_FAILED = "Couldn't load what your leads remember.";
export const KIN_MEMORY_EMPTY = {
  title: "Nothing remembered yet",
  detail: "What your leads learn while working with you shows up here.",
};
const KIN_MEMORY_CHANGE_FAILED = "Couldn't change that. Try again.";
const isKinChatError = Schema.is(KinChatError);
/** Why a tap didn't go through; the host's own words only where it wrote them for the owner. */
const problemOf = (cause: unknown) =>
  !isKinChatError(cause)
    ? KIN_MEMORY_CHANGE_FAILED
    : cause.reason === "not_found"
      ? "Your leads no longer remember that, so nothing changed."
      : cause.reason === "not_allowed"
        ? cause.message
        : KIN_MEMORY_CHANGE_FAILED;
/** Forgetting is asked once more first: the page has no way to bring an item back. */
export const KIN_MEMORY_FORGET = {
  action: "Forget",
  title: "Forget this?",
  body: (title: string) =>
    `Your leads will stop using “${title}”. You can't bring it back from here.`,
};
const SHARE = "Let the team know";
const KEEP = "Keep to myself";
/** A list this short is skimmed faster than it is searched. */
const SEARCH_FROM = 9;

const SECTIONS: ReadonlyArray<{
  readonly state: KinMemoryVisibility;
  readonly title: string;
  readonly hint: string;
}> = [
  {
    state: "suggested",
    title: "Waiting for your yes",
    hint: "Your leads think the team could know these. Until you say yes, only you can.",
  },
  {
    state: "team",
    title: "The team can know",
    hint: "Your leads can use these when they work with teammates.",
  },
  {
    state: "only_owner",
    title: "Only you",
    hint: "Your leads use these only when they work with you.",
  },
];

/** How an item reads after a tap: who may know it, or gone from the list. */
type KinMemoryItemState = KinMemoryVisibility | "forgotten";

/** The owner's taps over the list they were made on, until the host's own list says the same. */
export interface KinMemoryEdits {
  /** Taps the host hasn't answered yet: how each item reads meanwhile. */
  readonly pending: ReadonlyMap<string, KinMemoryItemState>;
  /** The host's answers, kept only while `settledOver` is still the list on screen. */
  readonly settled: ReadonlyMap<string, KinMemoryItemState>;
  readonly settledOver: KinMemoryListResult | null;
  /** The last tap that didn't go through, in words for the owner. */
  readonly problem: string | null;
}

export const KIN_MEMORY_NO_EDITS: KinMemoryEdits = {
  pending: new Map(),
  settled: new Map(),
  settledOver: null,
  problem: null,
};

const without = <V>(map: ReadonlyMap<string, V>, ids: ReadonlyArray<string>) => {
  const next = new Map(map);
  for (const id of ids) next.delete(id);
  return next;
};

export function kinMemoryStarted(
  edits: KinMemoryEdits,
  itemIds: ReadonlyArray<string>,
  to: KinMemoryItemState,
): KinMemoryEdits {
  const pending = new Map(edits.pending);
  for (const id of itemIds) pending.set(id, to);
  return { ...edits, pending, problem: null };
}

/** The host answered: its word replaces the tap's, and an item it left alone falls back. */
function kinMemorySettled(
  edits: KinMemoryEdits,
  list: KinMemoryListResult,
  itemIds: ReadonlyArray<string>,
  answered: ReadonlyArray<{ readonly itemId: string; readonly visibility: KinMemoryItemState }>,
): KinMemoryEdits {
  const settled = new Map(edits.settledOver === list ? edits.settled : []);
  for (const item of answered) settled.set(item.itemId, item.visibility);
  return { ...edits, pending: without(edits.pending, itemIds), settled, settledOver: list };
}

function kinMemoryFailed(
  edits: KinMemoryEdits,
  itemIds: ReadonlyArray<string>,
  problem: string,
): KinMemoryEdits {
  return { ...edits, pending: without(edits.pending, itemIds), problem };
}

const shownAs = (item: KinMemoryListItem, list: KinMemoryListResult, edits: KinMemoryEdits) =>
  edits.pending.get(item.itemId) ??
  (edits.settledOver === list ? edits.settled.get(item.itemId) : undefined) ??
  item.visibility;

export interface KinMemoryItemView {
  readonly itemId: KinMemoryItemId;
  readonly title: string;
  readonly preview: string | null;
  /** "Priya said this in Launch room", for something a teammate said. */
  readonly from: string | null;
  readonly state: KinMemoryVisibility;
  /** A tap on it is on its way to the host. */
  readonly busy: boolean;
  readonly forget: { readonly label: string; readonly accessibilityLabel: string };
  /** What a tap can make of it, the yes first. */
  readonly actions: ReadonlyArray<{
    readonly to: "team" | "only_owner";
    readonly label: string;
    readonly accessibilityLabel: string;
  }>;
}

export type KinMemoryRow =
  | {
      readonly type: "section";
      readonly key: string;
      readonly state: KinMemoryVisibility;
      readonly title: string;
      readonly hint: string;
      readonly count: number;
    }
  | { readonly type: "item"; readonly key: string; readonly item: KinMemoryItemView };

export interface KinMemoryConfirmAll {
  readonly label: string;
  readonly itemIds: ReadonlyArray<KinMemoryItemId>;
  readonly requests: ReadonlyArray<KinMemoryConfirmRequest>;
}

export interface KinMemoryView {
  /** Section headings and items in one flat list, so a long memory can be virtualised. */
  readonly rows: ReadonlyArray<KinMemoryRow>;
  /** Items still remembered: one being forgotten is already gone. */
  readonly total: number;
  readonly searchable: boolean;
  /** Set when a search leaves nothing: "Nothing matches “pricing”." */
  readonly noMatch: string | null;
  /** One tap for every suggestion on screen; null when fewer than two wait. */
  readonly confirmAll: KinMemoryConfirmAll | null;
}

type KinMemoryConfirmRequest = Omit<KinMemoryConfirmSuggestionsInput, "orgId">;

const actionsFor = (item: KinMemoryListItem, state: KinMemoryVisibility) => {
  const share = {
    to: "team" as const,
    label: SHARE,
    accessibilityLabel: `${SHARE}: ${item.title}`,
  };
  const keep = {
    to: "only_owner" as const,
    label: KEEP,
    accessibilityLabel: `${KEEP}: ${item.title}`,
  };
  return state === "suggested" ? [share, keep] : state === "team" ? [keep] : [share];
};

const matches = (item: KinMemoryListItem, words: ReadonlyArray<string>) => {
  const text = [item.title, item.preview ?? "", item.from?.name ?? "", item.from?.chatName ?? ""]
    .join("\n")
    .toLowerCase();
  return words.every((word) => text.includes(word));
};

/**
 * Yes to the suggestions on screen: each named with the version the owner was shown, so the host
 * confirms only those words, and nothing that arrived since.
 */
function confirmRequests(
  list: KinMemoryListResult,
  shown: ReadonlyArray<KinMemoryItemId>,
): ReadonlyArray<KinMemoryConfirmRequest> {
  const versionOf = new Map(
    list.items
      .filter((item) => item.visibility === "suggested")
      .map((item) => [item.itemId, item.version]),
  );
  const requests = [];
  for (let start = 0; start < shown.length; start += KIN_MEMORY_CONFIRM_MAX) {
    const itemIds = shown.slice(start, start + KIN_MEMORY_CONFIRM_MAX);
    const versions: Record<string, string> = {};
    for (const itemId of itemIds) {
      const version = versionOf.get(itemId);
      if (version !== undefined) versions[itemId] = version;
    }
    requests.push({ itemIds, versions });
  }
  return requests;
}

export function kinMemoryView(
  list: KinMemoryListResult,
  edits: KinMemoryEdits,
  search: string,
): KinMemoryView {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const items = list.items.flatMap((item) => {
    const state = shownAs(item, list, edits);
    return state === "forgotten" ? [] : [{ item, state }];
  });
  const found = words.length === 0 ? items : items.filter(({ item }) => matches(item, words));
  const rows: Array<KinMemoryRow> = [];
  for (const section of SECTIONS) {
    const inSection = found.filter(({ state }) => state === section.state);
    if (inSection.length === 0) continue;
    rows.push({
      type: "section",
      key: `section:${section.state}`,
      ...section,
      count: inSection.length,
    });
    for (const { item, state } of inSection) {
      const preview = (item.preview ?? "").trim();
      rows.push({
        type: "item",
        key: item.itemId,
        item: {
          itemId: item.itemId,
          title: item.title,
          preview: preview === "" || preview === item.title.trim() ? null : preview,
          from: item.from === null ? null : `${item.from.name} said this in ${item.from.chatName}`,
          state,
          busy: edits.pending.has(item.itemId),
          forget: {
            label: KIN_MEMORY_FORGET.action,
            accessibilityLabel: `${KIN_MEMORY_FORGET.action}: ${item.title}`,
          },
          actions: actionsFor(item, state),
        },
      });
    }
  }
  // A suggestion mid-tap is already going one way; "all" takes the ones still waiting.
  const waiting = found
    .filter(({ item, state }) => state === "suggested" && !edits.pending.has(item.itemId))
    .map(({ item }) => item.itemId);
  return {
    rows,
    total: items.length,
    searchable: items.length >= SEARCH_FROM,
    noMatch: rows.length === 0 && words.length > 0 ? `Nothing matches “${search.trim()}”.` : null,
    // One suggestion has its own yes beside it.
    confirmAll:
      waiting.length < 2
        ? null
        : {
            label: `${SHARE} ${words.length > 0 ? "these" : "all"} ${waiting.length}`,
            itemIds: waiting,
            requests: confirmRequests(list, waiting),
          },
  };
}

/** The second line of the way in, which is where the owner sees that suggestions wait. */
export function kinMemoryEntrySummary(list: KinMemoryListResult | null): string {
  const waiting = list?.items.filter((item) => item.visibility === "suggested").length ?? 0;
  return waiting === 0
    ? "What your leads remember"
    : waiting === 1
      ? "1 thing is waiting for your yes"
      : `${waiting} things are waiting for your yes`;
}

type Sent<A> = Promise<AtomCommandResult<A, unknown>>;

/**
 * The owner's taps, shown at once and taken back if the host refuses. The list is read again only
 * when nothing is in flight, so a run of taps over a slow connection costs one read.
 */
export function createKinMemoryActions(options: {
  readonly orgId: KinOrgId;
  readonly setVisibility: (
    input: KinMemorySetVisibilityInput,
  ) => Sent<KinMemorySetVisibilityResult>;
  readonly confirmSuggestions: (
    input: KinMemoryConfirmSuggestionsInput,
  ) => Sent<KinMemoryConfirmSuggestionsResult>;
  readonly forget: (input: KinMemoryForgetInput) => Sent<KinMemoryForgetResult>;
  readonly update: (change: (edits: KinMemoryEdits) => KinMemoryEdits) => void;
  readonly refresh: () => void;
}) {
  const { orgId, update } = options;
  let inFlight = 0;
  const run = async (
    list: KinMemoryListResult,
    itemIds: ReadonlyArray<KinMemoryItemId>,
    to: KinMemoryItemState,
    send: () => Promise<
      | {
          readonly answered: ReadonlyArray<{
            readonly itemId: string;
            readonly visibility: KinMemoryItemState;
          }>;
        }
      | { readonly failed: unknown }
    >,
  ) => {
    inFlight += 1;
    update((edits) => kinMemoryStarted(edits, itemIds, to));
    const outcome = await send();
    update((edits) =>
      "failed" in outcome
        ? kinMemoryFailed(edits, itemIds, problemOf(outcome.failed))
        : kinMemorySettled(edits, list, itemIds, outcome.answered),
    );
    inFlight -= 1;
    if (inFlight === 0) options.refresh();
  };
  return {
    /** One item, one way: the team can know it, or the owner keeps it. */
    change: (list: KinMemoryListResult, itemId: KinMemoryItemId, to: "team" | "only_owner") =>
      run(list, [itemId], to, async () => {
        // The host refuses a yes to words other than the ones the owner was shown.
        const version = list.items.find((item) => item.itemId === itemId)?.version;
        if (to === "team" && version === undefined) return { failed: undefined };
        const result = await options.setVisibility(
          to === "team" && version !== undefined
            ? { orgId, itemId, onlyOwner: false, version }
            : { orgId, itemId, onlyOwner: true },
        );
        return AsyncResult.isSuccess(result)
          ? { answered: [result.value.item] }
          : { failed: squashAtomCommandFailure(result) };
      }),
    /** Yes to every suggestion on screen. */
    confirmAll: (list: KinMemoryListResult, all: KinMemoryConfirmAll) =>
      run(list, all.itemIds, "team", async () => {
        const answered: Array<KinMemoryListItem> = [];
        for (const request of all.requests) {
          const result = await options.confirmSuggestions({ orgId, ...request });
          if (!AsyncResult.isSuccess(result)) return { failed: squashAtomCommandFailure(result) };
          answered.push(...result.value.items);
        }
        return { answered };
      }),
    /** Gone from the list at once; back, with the reason, if the host refuses. */
    forget: (list: KinMemoryListResult, itemId: KinMemoryItemId) =>
      run(list, [itemId], "forgotten", async () => {
        const result = await options.forget({ orgId, itemId });
        return AsyncResult.isSuccess(result)
          ? { answered: [{ itemId: result.value.itemId, visibility: "forgotten" as const }] }
          : { failed: squashAtomCommandFailure(result) };
      }),
    dismissProblem: () => update((edits) => ({ ...edits, problem: null })),
  };
}

export type KinMemoryActions = ReturnType<typeof createKinMemoryActions>;
