import {
  KIN_MEMORY_CHANGES_CARD,
  KinChatError,
  KinMemoryChangeCard,
  type KinAgentId,
  type KinMemoryConfirmSuggestionsInput,
  type KinMemoryConfirmSuggestionsResult,
  type KinMemoryListInput,
  type KinMemoryListItem,
  type KinMemoryListResult,
  type KinMemorySetVisibilityInput,
  type KinMemorySetVisibilityResult,
  type KinMemoryUndoInput,
  type KinMemoryUndoResult,
  type KinOrgId,
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

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import type { MemoryItem } from "./MemoryCache.ts";
import type { MemoryWriter } from "./MemoryWriter.ts";
import {
  authorise,
  bindSuggestions,
  fingerprint,
  hold,
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
  /** Every current item on the default branch, with its body. */
  readonly items: (
    orgId: KinOrgId,
  ) => Effect.Effect<ReadonlyArray<MemoryItem>, { readonly _tag: string }>;
}

/**
 * The owner's own actions on what the leads remember: per-item Undo on the `memory_changes` cards
 * earlier versions posted, and seeing and choosing who may know each item. No MCP tool or agent
 * path reaches them, and only the organization's owner may call the rest.
 */
export class KinMemoryChanges extends Context.Service<
  KinMemoryChanges,
  {
    readonly undo: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinMemoryUndoInput,
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
    readonly attachWriter: (port: KinMemoryPort) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/kin/memory/MemoryChanges/KinMemoryChanges") {}

const decodeCard = Schema.decodeUnknownEffect(KinMemoryChangeCard);
const encodeCard = Schema.encodeEffect(KinMemoryChangeCard);
const refused = (reason: KinChatError["reason"], message: string) =>
  new KinChatError({ reason, message });
const notFound = refused("not_found", "Kin record not found.");
const notAllowed = refused("not_allowed", "Only the lead's owner can undo its memory changes.");
const ownerOnly = refused("not_allowed", "Only the owner can see or change this.");
const unavailable = refused("unavailable", "Kin memory is unavailable. Try again.");
const stale = refused("conflict", "This changed again since, so it wasn't undone.");
const changed = refused("conflict", "This item changed since it was listed. Look at it again.");
const isKinChatError = Schema.is(KinChatError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Hub.KinChatHub;
  const { owner } = yield* KinIdentity;
  let port: KinMemoryPort | undefined;
  const provideSql = Effect.provideService(SqlClient.SqlClient, sql);
  /** Shown as turns treat it: only a stored authorisation of what it says now lets the team know. */
  const listed = (item: MemoryItem, labels: StoredLabels): KinMemoryListItem => ({
    itemId: item.head.id,
    kind: item.head.kind,
    title: item.head.title,
    visibility: visibility(item, labels),
    from:
      item.head.shared_from === undefined
        ? null
        : { name: item.head.shared_from.name, chatName: item.head.shared_from.chat_name },
    version: fingerprint(item),
  });
  // Settled reminders and replaced notes are history, not something a lead still uses.
  const current = (items: ReadonlyArray<MemoryItem>) =>
    items.filter(
      ({ head }) =>
        head.status === "open" && head.invalid_at === null && head.superseded_by === null,
    );
  const ownerOf = Effect.fn("KinMemoryChanges.ownerOf")(function* (
    people: ReadonlyArray<PersonIdentity>,
    orgId: KinOrgId,
  ) {
    const person = people.find((candidate) => candidate.orgId === orgId);
    if (person === undefined) return yield* notFound;
    if (person.orgId !== owner.orgId || person.personId !== owner.personId) return yield* ownerOnly;
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
    function* (people: ReadonlyArray<PersonIdentity>, input: KinMemoryUndoInput) {
      const person = people.find((candidate) => candidate.orgId === input.orgId);
      if (person === undefined) return yield* notFound;
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
        })
        .pipe(
          Effect.catch((error) =>
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
      const { port } = yield* ownerOf(people, input.orgId);
      const items = current(yield* port.items(input.orgId));
      const labels = yield* storedLabels(input.orgId).pipe(
        Effect.flatMap((stored) => bindSuggestions(input.orgId, items, stored)),
        provideSql,
      );
      const listedItems = items.map((item) => listed(item, labels));
      const shown = new Set<string>(
        listedItems.filter((item) => item.visibility === "suggested").map((item) => item.itemId),
      );
      return {
        items: listedItems,
        suggestionsAsOf: Math.max(
          0,
          ...[...labels.suggested].flatMap(([id, { rev }]) => (shown.has(id) ? [rev] : [])),
        ),
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
      if (!input.onlyOwner && input.version !== undefined && input.version !== words)
        return yield* changed;
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
      return { item: listed(next, yield* storedLabels(input.orgId).pipe(provideSql)) };
    }, failed),
    confirmSuggestions: Effect.fn("KinMemoryChanges.confirmSuggestions")(function* (people, input) {
      const { person, port } = yield* ownerOf(people, input.orgId);
      const items = current(yield* port.items(input.orgId));
      const labels = yield* storedLabels(input.orgId).pipe(provideSql);
      const asked = "itemIds" in input ? new Set<string>(input.itemIds) : undefined;
      const versions = "itemIds" in input ? input.versions : undefined;
      const counts = new Map<string, number>();
      for (const { head } of items) counts.set(head.id, (counts.get(head.id) ?? 0) + 1);
      const chosen = items.filter((item) => {
        const suggestion = labels.suggested.get(item.head.id);
        return (
          suggestion !== undefined &&
          counts.get(item.head.id) === 1 &&
          visibility(item, labels) === "suggested" &&
          (versions?.[item.head.id] === undefined ||
            versions[item.head.id] === fingerprint(item)) &&
          (asked === undefined
            ? "asOf" in input && suggestion.rev <= input.asOf
            : asked.has(item.head.id))
        );
      });
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
      return { items: confirmed.map((item) => listed(item, after)) };
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
