import {
  KIN_MEMORY_CHANGES_CARD,
  KinChatError,
  KinChatId,
  KinMemoryChangeCard,
  KinMessageId,
  type KinAgentId,
  type KinMemoryConfirmSuggestionsInput,
  type KinMemoryConfirmSuggestionsResult,
  type KinMemoryForgetInput,
  type KinMemoryForgetResult,
  type KinMemoryItemId,
  type KinMemoryListInput,
  type KinMemoryListItem,
  type KinMemoryListResult,
  type KinMemoryRestoreInput,
  type KinMemoryRestoreResult,
  type KinMemorySetTeamMemoryInput,
  type KinMemorySetTeamMemoryResult,
  type KinMemorySetVisibilityInput,
  type KinMemorySetVisibilityResult,
  type KinMemoryUndoInput,
  type KinMemoryUndoResult,
  type KinOrgId,
  type KinPersonId,
  type KinWidgetId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { endedBy } from "./frontMatter.ts";
import { CHAT_SOURCE, readableSources } from "./quoteAccess.ts";
import type { MemoryItem } from "./MemoryCache.ts";
import type { KinDecision, MemoryUndo, MemoryWriter } from "./MemoryWriter.ts";
import {
  authorise,
  bindSuggestions,
  fingerprint,
  hold,
  setTeamMemory,
  storedLabels,
  visibility,
  type StoredLabels,
} from "./sensitivity.ts";

/** The writer's Undo, attached by the lead runtime that owns the writer. */
export type KinMemoryUndo = MemoryWriter["Service"]["undoChange"];
/** What the owner's own memory actions need of the lead runtime, which owns memory and its writer. */
export interface KinMemoryPort {
  readonly undo: KinMemoryUndo;
  readonly relabel: MemoryWriter["Service"]["relabel"];
  readonly retire: MemoryWriter["Service"]["retire"];
  readonly restore: MemoryWriter["Service"]["restore"];
  readonly recordDecision: MemoryWriter["Service"]["recordDecision"];
  /** Every current item on the default branch, with its body. */
  readonly items: (
    orgId: KinOrgId,
  ) => Effect.Effect<ReadonlyArray<MemoryItem>, { readonly _tag: string }>;
  /** The items as last loaded, with no lock, sync or repair (`Memory.snapshotItems`). */
  readonly snapshot?: (orgId: KinOrgId) => Effect.Effect<ReadonlyArray<MemoryItem> | undefined>;
}

/**
 * The owner's own actions on what the leads remember: per-item Undo on the `memory_changes` cards
 * earlier versions posted, and seeing and choosing who may know each item. A person's coding
 * agent key can undo a change to a team-readable line with the same card ownership check.
 */
export class KinMemoryChanges extends Context.Service<
  KinMemoryChanges,
  {
    readonly undo: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinMemoryUndoInput,
      checkKey?: Effect.Effect<void, KinChatError>,
    ) => Effect.Effect<KinMemoryUndoResult, KinChatError>;
    /** What the leads remember and who may know each item; the owner only. */
    readonly list: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinMemoryListInput,
    ) => Effect.Effect<KinMemoryListResult, KinChatError>;
    /**
     * The owner's choice for one item. "Only you" holds at once; "the team can know" is stored as
     * the owner's authorisation of the item as it reads now, and its file records who and when.
     */
    readonly setVisibility: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinMemorySetVisibilityInput,
    ) => Effect.Effect<KinMemorySetVisibilityResult, KinChatError>;
    /** The owner confirms suggestions that the team could know items; the owner only. */
    readonly confirmSuggestions: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinMemoryConfirmSuggestionsInput,
    ) => Effect.Effect<KinMemoryConfirmSuggestionsResult, KinChatError>;
    /**
     * The owner removes one item: marked no longer true, so no lead uses it again, and kept in
     * history.
     */
    readonly forget: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinMemoryForgetInput,
    ) => Effect.Effect<KinMemoryForgetResult, KinChatError>;
    /** The way back from `forget`, for an item the owner forgot; the owner only. */
    readonly restore: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinMemoryRestoreInput,
    ) => Effect.Effect<KinMemoryRestoreResult, KinChatError>;
    /**
     * Saves a decision Kin saw made, by code. Server-only, never a tool or RPC; a failure is
     * logged, since the answer it records already stands.
     */
    readonly recordDecision: (orgId: KinOrgId, decision: KinDecision) => Effect.Effect<void>;
    /**
     * Current items that hold every word, newest first, for search; the owner level only, and
     * nothing for anyone else or while memory isn't running here. `teamOnly` keeps to what the
     * team may know, before the limit.
     */
    readonly search: (
      people: ReadonlyArray<PersonIdentity>,
      input: {
        readonly orgId: KinOrgId;
        readonly text: string;
        readonly limit: number;
        readonly teamOnly?: boolean;
        /** From the items as last loaded (`KinMemoryPort.snapshot`): no lock, sync or repair. */
        readonly snapshot?: boolean;
      },
    ) => Effect.Effect<ReadonlyArray<KinMemoryHit>>;
    /** The owner's switch for team memory in chats with teammates; owner level only. */
    readonly setTeamMemory: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinMemorySetTeamMemoryInput,
    ) => Effect.Effect<KinMemorySetTeamMemoryResult, KinChatError>;
    readonly attachWriter: (port: KinMemoryPort) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/kin/memory/MemoryChanges/KinMemoryChanges") {}

export type KinMemoryHit = {
  readonly itemId: KinMemoryItemId;
  readonly title: string;
  readonly snippet: string;
  readonly sensitive: boolean;
  readonly recordedAt: number;
  /** Who said it, as its file records them: for naming them, never to show as it is. */
  readonly saidBy: string;
  readonly trust: MemoryItem["head"]["trust"];
  /** A teammate's attribution by the names kept when it was said. */
  readonly from: { readonly name: string; readonly chatName: string } | null;
};
const SEARCH_SNIPPET = 160;
const searchWords = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
    .slice(0, 12);

const decodeCard = Schema.decodeUnknownEffect(KinMemoryChangeCard);
const encodeCard = Schema.encodeEffect(KinMemoryChangeCard);
const refused = (reason: KinChatError["reason"], message: string) =>
  new KinChatError({ reason, message });
const notFound = refused("not_found", "Kin record not found.");
const notAllowed = refused("not_allowed", "Only the agent's owner can undo its memory changes.");
const ownerOnly = refused("not_allowed", "Only the owner can see or change this.");
const unavailable = refused("unavailable", "Kin memory is unavailable. Try again.");
const stale = refused("conflict", "This changed again since, so it wasn't undone.");
const changed = refused("conflict", "This item changed since it was listed. Look at it again.");
const isKinChatError = Schema.is(KinChatError);
const PREVIEW_MAX = 200;
type Provenance = NonNullable<KinMemoryListItem["provenance"]>;
/** The item's own one-line account, else the start of what it says. */
const previewOf = ({ head, body }: MemoryItem) => {
  const text = (head.what ?? body).replace(/\s+/g, " ").trim();
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : text;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Hub.KinChatHub;
  const { owner } = yield* KinIdentity;
  let port: KinMemoryPort | undefined;
  const refresh = yield* KinRefreshObserver;
  // The labels these write are what the memory page reads, so their commits tell its refresh.
  const provideSql = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(KinRefreshObserver, refresh),
    );
  /** Shown as turns treat it: only a stored authorisation of what it says now lets the team know. */
  const listed = (
    item: MemoryItem,
    labels: StoredLabels,
    provenance: (item: MemoryItem) => Provenance,
  ): KinMemoryListItem => ({
    itemId: item.head.id,
    kind: item.head.kind,
    title: item.head.title,
    preview: previewOf(item),
    visibility: visibility(item, labels),
    from:
      item.head.shared_from === undefined
        ? null
        : { name: item.head.shared_from.name, chatName: item.head.shared_from.chat_name },
    provenance: provenance(item),
    version: fingerprint(item),
  });
  /**
   * Who said each item and when, with the words it quotes, only from a message the owner can
   * open in chat now (`readableSources`): one deleted, or in a chat he left, gives neither.
   */
  const provenanceOf = Effect.fn("KinMemoryChanges.provenanceOf")(
    function* (orgId: KinOrgId, person: KinPersonId, items: ReadonlyArray<MemoryItem>) {
      const saidAt = yield* readableSources(
        orgId,
        person,
        items.map(({ head }) => head.source),
      ).pipe(provideSql);
      return ({ head }: MemoryItem): Provenance => {
        const at = saidAt.get(head.source);
        const [, chatId, messageId] =
          (at === undefined ? null : CHAT_SOURCE.exec(head.source)) ?? [];
        return {
          saidBy: head.said_by,
          trust: head.trust,
          recordedAt: head.recorded_at,
          saidAt: at ?? null,
          quote: at === undefined ? null : (head.quote ?? null),
          ...(chatId === undefined || messageId === undefined
            ? {}
            : {
                message: {
                  chatId: KinChatId.make(chatId),
                  messageId: KinMessageId.make(messageId),
                },
              }),
        };
      };
    },
    Effect.mapError(toPersistenceSqlError("KinMemoryChanges.provenance")),
  );
  // Settled reminders and replaced notes are history; an `invalid_at` still ahead is true till then.
  const current = (items: ReadonlyArray<MemoryItem>, now: number) =>
    items.filter(
      ({ head }) => head.status === "open" && !endedBy(head, now) && head.superseded_by === null,
    );
  const forgottenOnes = (items: ReadonlyArray<MemoryItem>, now: number) =>
    items.filter(({ head }) => endedBy(head, now) && head.superseded_by === null);
  const ownerOf = Effect.fn("KinMemoryChanges.ownerOf")(function* (
    people: ReadonlyArray<PersonIdentity>,
    orgId: KinOrgId,
  ) {
    const person = people.find((candidate) => candidate.orgId === orgId);
    if (person === undefined) return yield* notFound;
    if (
      person.orgId !== owner.orgId ||
      !(yield* ownerLevel(orgId, person.personId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.orElseSucceed(() => false),
      ))
    )
      return yield* ownerOnly;
    if (port === undefined) return yield* unavailable;
    return { person, port };
  });
  const failed = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.tapError((error) =>
        isKinChatError(error)
          ? Effect.void
          : Effect.logWarning("Kin memory changes failed", { errorTag: error._tag }),
      ),
      Effect.mapError((error) => (isKinChatError(error) ? error : unavailable)),
    );

  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error) =>
          SqlError.isSqlError(error)
            ? toPersistenceSqlError("KinMemoryChanges.transaction")(error)
            : error,
        ),
      );
  const now = Clock.currentTimeMillis.pipe(
    Effect.map((ms) => DateTime.formatIso(DateTime.makeUnsafe(ms))),
  );

  /** The lead's owner and its direct chat, from stored rows. */
  const ownerChat = Effect.fn("KinMemoryChanges.ownerChat")(function* (
    orgId: KinOrgId,
    agentId: KinAgentId,
  ) {
    const [row] = yield* sql<{ chatId: string; owner: string }>`SELECT l.owner_chat_id AS "chatId",
        a.owner_person_id AS owner FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      JOIN kin_chats c ON c.org_id = l.org_id AND c.chat_id = l.owner_chat_id AND c.kind = 'direct'
      WHERE l.org_id = ${orgId} AND l.agent_id = ${agentId}
        AND a.role = 'lead' AND a.retired_at IS NULL
      ORDER BY l.agent_id`.pipe(Effect.mapError(toPersistenceSqlError("KinMemoryChanges.owner")));
    return row;
  });

  const mark = Effect.fn("KinMemoryChanges.mark")(function* (
    orgId: KinOrgId,
    widgetId: KinWidgetId,
    itemId: string,
    undo: "undone" | "stale",
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const current = yield* repo.getWidget({ orgId, widgetId });
        if (Option.isNone(current)) return yield* notFound;
        const card = yield* decodeCard(current.value.state);
        const next = {
          ...card,
          items: card.items.map((item) => (item.itemId === itemId ? { ...item, undo } : item)),
        };
        const widget = yield* repo.updateWidget({
          ...current.value,
          audience: "owner",
          state: yield* encodeCard(next),
          expectedRevision: current.value.revision,
          updatedAt: yield* now,
        });
        yield* sql.afterCommit(hub.publish({ type: "widget.updated", orgId, widget }));
        return next;
      }),
    );
  });

  const undo = Effect.fn("KinMemoryChanges.undo")(
    function* (
      people: ReadonlyArray<PersonIdentity>,
      input: KinMemoryUndoInput,
      checkKey?: Effect.Effect<void, KinChatError>,
    ) {
      const person = people.find((candidate) => candidate.orgId === input.orgId);
      if (person === undefined) return yield* notFound;
      if (checkKey !== undefined) {
        yield* checkKey;
        if (!(yield* ownerLevel(input.orgId, person.personId).pipe(provideSql)))
          return yield* notAllowed;
      }
      const widget = yield* repo.getWidget({ orgId: input.orgId, widgetId: input.widgetId });
      if (Option.isNone(widget) || widget.value.type !== KIN_MEMORY_CHANGES_CARD)
        return yield* notFound;
      const card = yield* decodeCard(widget.value.state);
      const owner = yield* ownerChat(input.orgId, card.agentId);
      if (
        owner === undefined ||
        owner.owner !== person.personId ||
        owner.chatId !== widget.value.chatId
      )
        return yield* notAllowed;
      const item = card.items.find((candidate) => candidate.itemId === input.itemId);
      if (item === undefined) return yield* notFound;
      let codingAgent: MemoryUndo["codingAgent"];
      if (checkKey !== undefined) {
        const reachableItem = Effect.fn("KinMemoryChanges.undoReachable")(function* () {
          const snapshot = (yield* port?.snapshot?.(input.orgId) ?? Effect.undefined) ?? [];
          const matches = current(snapshot, yield* Clock.currentTimeMillis).filter(
            (one) => one.head.id === input.itemId,
          );
          const [known] = matches;
          const labels = yield* storedLabels(input.orgId).pipe(provideSql);
          if (known === undefined || matches.length !== 1 || visibility(known, labels) !== "team")
            return yield* notFound;
          return known;
        }, failed);
        yield* reachableItem();
        codingAgent = {
          personId: person.personId,
          admit: Effect.fn("KinMemoryChanges.admitUndo")(function* (locked) {
            yield* checkKey;
            if (
              !(yield* ownerLevel(input.orgId, person.personId).pipe(
                provideSql,
                Effect.orElseSucceed(() => false),
              ))
            )
              return yield* notAllowed;
            if (fingerprint(yield* reachableItem()) !== fingerprint(locked)) return yield* notFound;
          }),
        };
      }
      if (item.undo === "undone") return { card };
      if (item.undo === "stale") return yield* stale;
      if (port === undefined) return yield* unavailable;
      const result = yield* port
        .undo(input.orgId, {
          agentId: card.agentId,
          itemId: item.itemId,
          path: item.path,
          branch: card.branch,
          base: card.base,
          commit: card.commit,
          ...(codingAgent === undefined ? {} : { codingAgent }),
        })
        .pipe(
          Effect.catchIf(
            (error) => !isKinChatError(error),
            (error) =>
              Effect.logWarning("Kin memory undo failed", { errorTag: error._tag }).pipe(
                Effect.andThen(
                  Effect.fail(
                    error._tag === "MemorySecretBlocked"
                      ? refused("invalid_state", "The earlier version looks like it has a secret.")
                      : unavailable,
                  ),
                ),
              ),
          ),
        );
      const next = yield* mark(
        input.orgId,
        input.widgetId,
        item.itemId,
        result._tag === "undone" ? "undone" : "stale",
      );
      if (result._tag === "stale") return yield* stale;
      return { card: next };
    },
    Effect.catchIf(
      (error) => !isKinChatError(error),
      (error) =>
        Effect.logWarning("Kin memory changes failed", error).pipe(
          Effect.andThen(Effect.fail(unavailable)),
        ),
    ),
  );

  return KinMemoryChanges.of({
    undo,
    list: Effect.fn("KinMemoryChanges.list")(function* (people, input) {
      const { person, port } = yield* ownerOf(people, input.orgId);
      const all = yield* port.items(input.orgId);
      const at = yield* Clock.currentTimeMillis;
      const items = input.forgotten === true ? forgottenOnes(all, at) : current(all, at);
      const labels = yield* storedLabels(input.orgId).pipe(
        Effect.flatMap((stored) => bindSuggestions(input.orgId, items, stored)),
        provideSql,
      );
      const provenance = yield* provenanceOf(input.orgId, person.personId, items);
      return {
        items: items.map((item) => listed(item, labels, provenance)),
        teamMemory: labels.teamMemory,
      };
    }, failed),
    setVisibility: Effect.fn("KinMemoryChanges.setVisibility")(function* (people, input) {
      const { person, port } = yield* ownerOf(people, input.orgId);
      const known = (yield* port.items(input.orgId)).filter(
        (item) => item.head.id === input.itemId,
      );
      const [item] = known;
      if (item === undefined || known.length !== 1) return yield* notFound;
      // The team is let know only these words, and only if they are the listed version.
      const words = fingerprint(item);
      if (!input.onlyOwner && input.version !== words) return yield* changed;
      // Held first, so "only you" is true from this moment whatever the commit below does.
      if (input.onlyOwner) yield* hold(input.orgId, input.itemId).pipe(provideSql);
      const { head } = yield* port.relabel(input.orgId, {
        itemId: input.itemId,
        sensitive: input.onlyOwner,
        person: person.personId,
      });
      const next = { head, body: item.body };
      if (!input.onlyOwner) {
        if (fingerprint(next) !== words) return yield* changed;
        yield* authorise(input.orgId, input.itemId, words, "owner_setting").pipe(provideSql);
      }
      return {
        item: listed(
          next,
          yield* storedLabels(input.orgId).pipe(provideSql),
          yield* provenanceOf(input.orgId, person.personId, [next]),
        ),
      };
    }, failed),
    confirmSuggestions: Effect.fn("KinMemoryChanges.confirmSuggestions")(function* (people, input) {
      const { person, port } = yield* ownerOf(people, input.orgId);
      const items = current(yield* port.items(input.orgId), yield* Clock.currentTimeMillis);
      const labels = yield* storedLabels(input.orgId).pipe(provideSql);
      const asked = new Set<string>(input.itemIds);
      // Confirmed only as the version listed; one sent without it stays suggested.
      const listedAs = new Map(Object.entries(input.versions));
      const counts = new Map<string, number>();
      for (const { head } of items) counts.set(head.id, (counts.get(head.id) ?? 0) + 1);
      // Still suggested as these very words (`visibility`), and they are the words listed.
      const chosen = items.filter(
        (item) =>
          asked.has(item.head.id) &&
          counts.get(item.head.id) === 1 &&
          visibility(item, labels) === "suggested" &&
          listedAs.get(item.head.id) === fingerprint(item),
      );
      const confirmed = [];
      for (const item of chosen) {
        // The file records who let the team know it; the stored row is what decides it.
        const { head } = yield* port.relabel(input.orgId, {
          itemId: item.head.id,
          sensitive: false,
          person: person.personId,
        });
        const next = { head, body: item.body };
        // Still suggested above, so these are the words suggested and listed; nothing else.
        const words = fingerprint(item);
        if (fingerprint(next) !== words) continue;
        yield* authorise(input.orgId, item.head.id, words, "owner_confirmed").pipe(provideSql);
        confirmed.push(next);
      }
      const after = yield* storedLabels(input.orgId).pipe(provideSql);
      const provenance = yield* provenanceOf(input.orgId, person.personId, confirmed);
      return { items: confirmed.map((item) => listed(item, after, provenance)) };
    }, failed),
    forget: Effect.fn("KinMemoryChanges.forget")(function* (people, input) {
      const { port } = yield* ownerOf(people, input.orgId);
      const known = (yield* port.items(input.orgId)).filter(
        (item) => item.head.id === input.itemId,
      );
      if (known.length !== 1) return yield* notFound;
      yield* port.retire(input.orgId, { itemId: input.itemId, by: "owner" });
      return { itemId: input.itemId };
    }, failed),
    restore: Effect.fn("KinMemoryChanges.restore")(function* (people, input) {
      const { port } = yield* ownerOf(people, input.orgId);
      const known = forgottenOnes(
        yield* port.items(input.orgId),
        yield* Clock.currentTimeMillis,
      ).filter((item) => item.head.id === input.itemId);
      if (known.length !== 1) return yield* notFound;
      yield* port.restore(input.orgId, { itemId: input.itemId });
      return { itemId: input.itemId };
    }, failed),
    recordDecision: Effect.fn("KinMemoryChanges.recordDecision")(function* (orgId, decision) {
      if (port === undefined) return;
      const saved = yield* port.recordDecision(orgId, decision).pipe(Effect.result);
      if (saved._tag === "Failure")
        yield* Effect.logWarning("Kin couldn't save a decision to memory", {
          orgId,
          itemId: decision.itemId,
          errorTag: saved.failure._tag,
        });
    }),
    search: Effect.fn("KinMemoryChanges.search")(function* (people, input) {
      const words = searchWords(input.text);
      const allowed = yield* ownerOf(people, input.orgId).pipe(Effect.result);
      if (words.length === 0 || allowed._tag === "Failure") return [];
      const { port } = allowed.success;
      const all =
        input.snapshot === true
          ? ((yield* port.snapshot?.(input.orgId) ?? Effect.undefined) ?? [])
          : yield* port.items(input.orgId).pipe(
              Effect.tapError((error) =>
                Effect.logWarning("Kin memory search failed", { errorTag: error._tag }),
              ),
              Effect.orElseSucceed((): ReadonlyArray<MemoryItem> => []),
            );
      const now = yield* Clock.currentTimeMillis;
      const labels =
        input.teamOnly === true
          ? yield* storedLabels(input.orgId).pipe(
              provideSql,
              Effect.tapError((error) =>
                Effect.logWarning("Kin memory search failed", { errorTag: error._tag }),
              ),
              Effect.option,
            )
          : undefined;
      if (labels !== undefined && labels._tag === "None") return [];
      return current(all, now)
        .flatMap((item): ReadonlyArray<KinMemoryHit> => {
          if (labels !== undefined && visibility(item, labels.value) !== "team") return [];
          const text = `${item.head.title}\n${item.head.what ?? ""}\n${item.body}`;
          const lower = text.toLowerCase();
          if (!words.every((word) => lower.includes(word))) return [];
          const body = (item.head.what ?? item.body).replace(/\s+/g, " ").trim();
          const recordedAt = Date.parse(item.head.recorded_at);
          return [
            {
              itemId: item.head.id,
              title: item.head.title,
              snippet:
                body.length > SEARCH_SNIPPET
                  ? `${body.slice(0, SEARCH_SNIPPET - 1).trimEnd()}…`
                  : body,
              sensitive: item.head.sensitive !== false,
              recordedAt: Number.isFinite(recordedAt) ? recordedAt : 0,
              saidBy: item.head.said_by,
              trust: item.head.trust,
              from:
                item.head.shared_from === undefined
                  ? null
                  : {
                      name: item.head.shared_from.name,
                      chatName: item.head.shared_from.chat_name,
                    },
            },
          ];
        })
        .toSorted((a, b) => b.recordedAt - a.recordedAt || a.itemId.localeCompare(b.itemId))
        .slice(0, input.limit);
    }),
    setTeamMemory: Effect.fn("KinMemoryChanges.setTeamMemory")(function* (people, input) {
      const { person } = yield* ownerOf(people, input.orgId);
      yield* setTeamMemory(input.orgId, input.on, person.personId).pipe(provideSql);
      return { teamMemory: input.on };
    }, failed),
    attachWriter: Effect.fn("KinMemoryChanges.attachWriter")(function* (next) {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          port = next;
        }),
        () =>
          Effect.sync(() => {
            if (port === next) port = undefined;
          }),
      );
    }),
  });
});

export const layer = Layer.effect(KinMemoryChanges, make);
