import {
  KIN_MEMORY_CHANGES_CARD,
  KinChatError,
  KinMemoryChangeCard,
  type KinAgentId,
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
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import type { MemoryWriter } from "./MemoryWriter.ts";

/** The writer's Undo, attached by the lead runtime that owns the writer. */
export type KinMemoryUndo = MemoryWriter["Service"]["undoChange"];

/**
 * Per-item Undo on the `memory_changes` cards earlier versions posted. Memory writes post nothing
 * now. No MCP tool or agent path reaches `undo`; it does only what the owner could already ask
 * the lead to do.
 */
export class KinMemoryChanges extends Context.Service<
  KinMemoryChanges,
  {
    readonly undo: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinMemoryUndoInput,
    ) => Effect.Effect<KinMemoryUndoResult, KinChatError>;
    readonly attachWriter: (undo: KinMemoryUndo) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/kin/memory/MemoryChanges/KinMemoryChanges") {}

const decodeCard = Schema.decodeUnknownEffect(KinMemoryChangeCard);
const encodeCard = Schema.encodeEffect(KinMemoryChangeCard);
const refused = (reason: KinChatError["reason"], message: string) =>
  new KinChatError({ reason, message });
const notFound = refused("not_found", "Kin record not found.");
const notAllowed = refused("not_allowed", "Only the lead's owner can undo its memory changes.");
const unavailable = refused("unavailable", "Kin memory is unavailable. Try again.");
const stale = refused("conflict", "This changed again since, so it wasn't undone.");
const isKinChatError = Schema.is(KinChatError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Hub.KinChatHub;
  let writer: KinMemoryUndo | undefined;

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
      if (writer === undefined) return yield* unavailable;
      const result = yield* writer(input.orgId, {
        agentId: card.agentId,
        itemId: item.itemId,
        path: item.path,
        branch: card.branch,
        base: card.base,
        commit: card.commit,
      }).pipe(
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
    attachWriter: Effect.fn("KinMemoryChanges.attachWriter")(function* (next) {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          writer = next;
        }),
        () =>
          Effect.sync(() => {
            if (writer === next) writer = undefined;
          }),
      );
    }),
  });
});

export const layer = Layer.effect(KinMemoryChanges, make);
