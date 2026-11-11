import {
  KinActionTarget,
  KinAgentId,
  KinChatError,
  KinChatId,
  KinEventId,
  KinLevel,
  ThreadId,
  type KinActionId,
  type KinLevelsGetInput,
  type KinLevelsRaiseResult,
  type KinLevelsSetInput,
  type KinLevelsView,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  KinPendingActions,
  KIN_LEVEL_REQUESTER,
  kinTargetDigest,
} from "../approvals/PendingActions.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import * as KinLevels from "../lead/KinLevels.ts";

type Lead = { readonly orgId: KinOrgId; readonly agentId: KinAgentId };

/**
 * The owner's internal control of a lead's permission: read, lower, and ask to raise. Raising
 * only creates a `set_level` action; the owner's signed grant and the executor's `set_level`
 * handler apply it. No client screen, MCP tool or agent path reaches this service.
 */
export class KinLevelControl extends Context.Service<
  KinLevelControl,
  {
    readonly view: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinLevelsGetInput,
    ) => Effect.Effect<KinLevelsView, KinChatError>;
    readonly lower: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinLevelsSetInput,
    ) => Effect.Effect<KinLevelsView, KinChatError>;
    readonly raise: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinLevelsSetInput,
    ) => Effect.Effect<KinLevelsRaiseResult, KinChatError>;
  }
>()("t3/kin/levels/LevelControl/KinLevelControl") {}

const decodeLevel = Schema.decodeUnknownEffect(KinLevel);
const decodeTarget = Schema.decodeUnknownEffect(Schema.fromJsonString(KinActionTarget));
type OpenRaiseState = "awaiting_approval" | "approved" | "executing";
const OPEN_ACTION_STATES: ReadonlyArray<string> = ["awaiting_approval", "approved", "executing"];
const isOpenRaiseState = (state: string): state is OpenRaiseState =>
  OPEN_ACTION_STATES.includes(state);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** What the owner's approval says the raise lets the lead do, in plain words. */
const raiseReason = (name: string, level: KinLevel, inChat: boolean) => {
  const where = inChat ? " in this chat" : "";
  switch (level) {
    case "L0":
    case "L1":
      return `Let ${name} post${where}.`;
    case "L2":
      return `Let ${name} start work${where}.`;
    case "L3":
      return `Let ${name} ask you to merge low-risk changes${where}.`;
  }
};

const refused = (reason: KinChatError["reason"], message: string) =>
  new KinChatError({ reason, message });
const notAllowed = refused("not_allowed", "Only the agent's owner can change what it may do.");
const notFound = refused("not_found", "Kin record not found.");
const unavailable = refused("unavailable", "Kin is unavailable.");
const LEVEL_REFUSALS: Record<KinLevels.KinLevelRefused["reason"], KinChatError> = {
  not_a_lead: notFound,
  not_found: notFound,
  conflict: refused("invalid_state", "The agent's permission changed meanwhile; try again."),
  invalid_level: refused(
    "invalid_state",
    "Lower goes down; raise goes up, and a chat at most back to the agent's own.",
  ),
  not_granted: refused("not_allowed", "This change needs the owner's signed approval."),
};

const isKinChatError = Schema.is(KinChatError);
const isLevelRefused = Schema.is(KinLevels.KinLevelRefused);
const toChatError = (error: unknown) =>
  isKinChatError(error)
    ? Effect.fail(error)
    : isLevelRefused(error)
      ? Effect.fail(LEVEL_REFUSALS[error.reason])
      : Effect.logWarning("Kin levels failed", error).pipe(
          Effect.andThen(Effect.fail(unavailable)),
        );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pending = yield* KinPendingActions;

  const withSql = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, SqlClient.SqlClient, sql);
  const run = <A>(operation: string, effect: Effect.Effect<A, SqlError.SqlError>) =>
    effect.pipe(Effect.mapError(toPersistenceSqlError(operation)));
  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error) =>
          SqlError.isSqlError(error)
            ? toPersistenceSqlError("KinLevelControl.transaction")(error)
            : error,
        ),
      );

  /** The caller is the lead's own owner, read from stored rows in the caller's org. */
  const asOwner = Effect.fn("KinLevelControl.asOwner")(function* (
    people: ReadonlyArray<PersonIdentity>,
    lead: Lead,
  ) {
    const person = people.find((candidate) => candidate.orgId === lead.orgId);
    if (person === undefined) return yield* notFound;
    const rows = yield* run(
      "KinLevelControl.asOwner",
      sql`SELECT 1 FROM kin_leads l
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        JOIN kin_people p ON p.org_id = a.org_id AND p.person_id = a.owner_person_id
        WHERE l.org_id = ${lead.orgId} AND l.agent_id = ${lead.agentId}
          AND a.role = 'lead' AND a.retired_at IS NULL AND a.owner_person_id = ${person.personId}
        ORDER BY l.agent_id`,
    );
    if (rows.length === 0) return yield* notAllowed;
    return person;
  });

  const leadRow = Effect.fn("KinLevelControl.leadRow")(function* (lead: Lead) {
    const [row] = yield* run(
      "KinLevelControl.leadRow",
      sql<{ name: string; level: string; since: number; ownerChatId: string }>`
        SELECT name, level, level_since AS since, owner_chat_id AS "ownerChatId" FROM kin_leads
        WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId} ORDER BY agent_id`,
    );
    if (row === undefined) return yield* notFound;
    return row;
  });

  const openRaises = Effect.fn("KinLevelControl.openRaises")(function* (lead: Lead) {
    const rows = yield* run(
      "KinLevelControl.openRaises",
      sql<{ actionId: KinActionId; revision: number; state: string; targetJson: string }>`
        SELECT action_id AS "actionId", revision, state, target_json AS "targetJson"
        FROM kin_pending_actions
        WHERE org_id = ${lead.orgId} AND kind = 'set_level'
          AND json_extract(target_json, '$.agentId') = ${lead.agentId}
          AND state IN ('awaiting_approval', 'approved', 'executing')
        ORDER BY created_at, action_id`,
    );
    return yield* Effect.forEach(rows, (row) =>
      decodeTarget(row.targetJson).pipe(
        Effect.map((target) =>
          target._tag === "level" && isOpenRaiseState(row.state)
            ? [{ ...row, state: row.state, chatId: target.chatId ?? null, level: target.level }]
            : [],
        ),
      ),
    ).pipe(Effect.map((all) => all.flat()));
  });

  /**
   * A lower level withdraws the raises it overtook: the lead's own and every chat's above a new
   * lead level, or that chat's above a new chat cap. An executing raise is refused by its handler.
   */
  const closeRaises = Effect.fn("KinLevelControl.closeRaises")(function* (
    lead: Lead,
    lowered: { readonly chatId?: KinChatId | undefined; readonly level: KinLevel },
  ) {
    for (const raise of yield* openRaises(lead)) {
      if (raise.state === "executing" || KinLevels.atLeast(lowered.level, raise.level)) continue;
      if (lowered.chatId !== undefined && raise.chatId !== lowered.chatId) continue;
      yield* pending.transition({
        orgId: lead.orgId,
        actionId: raise.actionId,
        revision: raise.revision,
        to: raise.state === "approved" ? "voided" : "cancelled",
        reason: "level_lowered",
      });
    }
  });

  const view = Effect.fn("KinLevelControl.view")(function* (lead: Lead) {
    const row = yield* leadRow(lead);
    const level = yield* decodeLevel(row.level);
    const chats = yield* run(
      "KinLevelControl.chatLevels",
      sql<{ chatId: string; level: string; since: number }>`
        SELECT chat_id AS "chatId", level, level_since AS since FROM kin_chat_levels
        WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}
        ORDER BY chat_id`,
    );
    // The owner's DM works at L2 without a row of its own; show it when that is above the lead.
    const dmChatId = KinChatId.make(row.ownerChatId);
    const dmLevel = chats.some((chat) => chat.chatId === row.ownerChatId)
      ? undefined
      : yield* withSql(KinLevels.effectiveLevel({ ...lead, chatId: dmChatId })).pipe(
          Effect.catchTags({ KinLevelRefused: () => Effect.undefined }),
        );
    return {
      orgId: lead.orgId,
      agentId: lead.agentId,
      level,
      levelSince: iso(row.since),
      chats: [
        ...(yield* Effect.forEach(chats, (chat) =>
          decodeLevel(chat.level).pipe(
            Effect.map((chatLevel) => ({
              chatId: KinChatId.make(chat.chatId),
              level: chatLevel,
              levelSince: iso(chat.since),
            })),
          ),
        )),
        ...(dmLevel === undefined || dmLevel === level
          ? []
          : [{ chatId: dmChatId, level: dmLevel, levelSince: iso(row.since) }]),
      ],
      pendingRaises: (yield* openRaises(lead)).map(({ actionId, chatId, level, state }) => ({
        actionId,
        chatId,
        level,
        state,
      })),
    } satisfies KinLevelsView;
  });

  return KinLevelControl.of({
    view: Effect.fn("KinLevelControl.get")(function* (people, input) {
      yield* asOwner(people, input);
      return yield* view(input);
    }, Effect.catch(toChatError)),

    lower: Effect.fn("KinLevelControl.lower")(function* (people, input) {
      yield* asOwner(people, input);
      yield* withSql(KinLevels.lower(input));
      yield* closeRaises(input, input).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Kin raise withdrawal failed", { cause })),
      );
      return yield* view(input);
    }, Effect.catch(toChatError)),

    raise: Effect.fn("KinLevelControl.raise")(function* (people, input) {
      const person = yield* asOwner(people, input);
      const chatKey = input.chatId ?? "";
      // The lead and chat membership are checked in the write that creates the row.
      const actionId = yield* transaction(
        Effect.gen(function* () {
          yield* withSql(KinLevels.checkRaise(input));
          const sameTarget = sql`kind = 'set_level' AND org_id = ${input.orgId}
              AND json_extract(target_json, '$.agentId') = ${input.agentId}
              AND json_extract(target_json, '$.level') = ${input.level}
              AND IFNULL(json_extract(target_json, '$.chatId'), '') = ${chatKey}`;
          const [open] = yield* run(
            "KinLevelControl.openRaise",
            sql<{ actionId: KinActionId }>`SELECT action_id AS "actionId" FROM kin_pending_actions
                WHERE ${sameTarget} AND state IN ('awaiting_approval', 'approved', 'executing')
                ORDER BY created_at DESC, action_id LIMIT 1`,
          );
          if (open !== undefined) return open.actionId;
          // A closed request (rejected, expired) gets a fresh one; a double tap lands on one row.
          const [count] = yield* run(
            "KinLevelControl.raiseCount",
            sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_pending_actions WHERE ${sameTarget}
                ORDER BY n`,
          );
          const lead = yield* leadRow(input);
          const target = {
            _tag: "level" as const,
            agentId: input.agentId,
            ...(input.chatId === undefined ? {} : { chatId: input.chatId }),
            level: input.level,
          };
          const created = yield* pending.create({
            orgId: input.orgId,
            kind: "set_level",
            target,
            resolved: { _tag: "none" },
            targetDigest: kinTargetDigest("set_level", target, { _tag: "none" }),
            reason: raiseReason(lead.name, input.level, input.chatId !== undefined),
            requestedBy: {
              agentId: KinAgentId.make(KIN_LEVEL_REQUESTER),
              threadId: ThreadId.make(KIN_LEVEL_REQUESTER),
            },
            provenance: {
              startedBy: { humanId: person.personId },
              startedByRole: "owner",
              chain: [],
              ceilingBelowOwner: false,
            },
            source: KinEventId.make(
              `set-level:${input.agentId}:${chatKey || "lead"}:${input.level}:${count?.n ?? 0}`,
            ),
          });
          return created.action.id;
        }),
      );
      return { actionId };
    }, Effect.catch(toChatError)),
  });
});

export const layer = Layer.effect(KinLevelControl, make);
