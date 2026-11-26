// @effect-diagnostics-next-line nodeBuiltinImport:off -- synchronous hashes keep raw prompt text out of shadow storage.
import * as NodeCrypto from "node:crypto";
import {
  KinWakeupId,
  type KinAgentId,
  type KinOrgId,
  type ModelSelection,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { KinWorkspace } from "../gendocs/workspace.ts";
import { unsetOwnerZone } from "../work/recordRows.ts";
import { turnSensitive } from "../work/sensitiveReads.ts";
import { turnChat } from "./Audience.ts";
import { outsideRead } from "./OutsideContent.ts";

export interface CarryFacts {
  readonly enabled: boolean;
  readonly provider: string | undefined;
  readonly ownerThread: boolean;
  readonly sameChat: boolean;
  readonly previousCompleted: boolean;
  readonly marked: boolean;
  readonly foreignRun: boolean;
  readonly gapMs: number | null;
  readonly contextTokens?: number | null;
  readonly compactAtTokens?: number;
  readonly compactedSince?: boolean;
  readonly sameBoot: boolean;
  readonly sameModel: boolean;
  readonly sameInstructions: boolean;
  readonly sameToolList: boolean;
  readonly sameLead: boolean;
  readonly sameMembers: boolean;
  readonly sameLists: boolean;
  readonly sameBudgets: boolean;
  readonly sameRecipes: boolean;
  readonly sameZone: boolean;
  readonly paused: boolean;
  readonly sameStanding: boolean;
  readonly indexLinesChanged: number;
  readonly missed: boolean;
}

export const CARRY_LIFETIME_MS = 55 * 60_000;
const CARRY_INDEX_LINES = 40;

export function decideCarry(facts: CarryFacts) {
  const reason = !facts.enabled
    ? "off"
    : facts.provider !== "claudeAgent"
      ? "provider"
      : !facts.ownerThread
        ? "thread"
        : !facts.sameChat
          ? "chat"
          : !facts.previousCompleted
            ? "ended"
            : facts.marked
              ? "marked"
              : facts.foreignRun
                ? "foreign_run"
                : facts.gapMs === null || facts.gapMs < 0 || facts.gapMs > CARRY_LIFETIME_MS
                  ? "expired"
                  : facts.contextTokens != null &&
                      facts.compactAtTokens !== undefined &&
                      facts.contextTokens > facts.compactAtTokens
                    ? "size"
                    : !facts.sameBoot
                      ? "boot"
                      : !facts.sameModel
                        ? "model"
                        : !facts.sameInstructions
                          ? "instructions"
                          : !facts.sameToolList
                            ? "tool_list"
                            : !facts.sameLead
                              ? "lead"
                              : !facts.sameMembers
                                ? "members"
                                : !facts.sameLists
                                  ? "lists"
                                  : !facts.sameBudgets
                                    ? "budgets"
                                    : !facts.sameRecipes
                                      ? "recipes"
                                      : !facts.sameZone
                                        ? "zone"
                                        : facts.paused
                                          ? "paused"
                                          : !facts.sameStanding
                                            ? "standing"
                                            : facts.indexLinesChanged > CARRY_INDEX_LINES
                                              ? "index"
                                              : facts.missed
                                                ? "missed"
                                                : undefined;
  if (reason !== undefined) return { carry: false as const, reason };
  return facts.compactedSince
    ? { carry: true as const, refill: true as const }
    : { carry: true as const };
}

const bootId = Effect.gen(function* () {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let timestamp = yield* Clock.currentTimeMillis;
  let value = "";
  for (let i = 0; i < 10; i++) {
    value = alphabet.charAt(timestamp % 32) + value;
    timestamp = Math.floor(timestamp / 32);
  }
  for (let i = 0; i < 16; i++) value += alphabet.charAt(yield* Random.nextIntBetween(0, 31));
  return value;
});
export { bootId as ulid };

export class KinBoot extends Context.Service<KinBoot, string>()(
  "t3/kin/lead/sessionCarry/KinBoot",
) {}
export const layer = Layer.effect(KinBoot, bootId);

const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const fingerprintJson = (value: unknown) => digest(JSON.stringify(value));

const Fingerprint = Schema.Struct({
  chat: Schema.NullOr(Schema.String),
  model: Schema.String,
  instructions: Schema.NullOr(Schema.String),
  lead: Schema.String,
  members: Schema.String,
  lists: Schema.optional(Schema.NullOr(Schema.String)),
  budgets: Schema.optional(Schema.NullOr(Schema.String)),
  recipes: Schema.optional(Schema.NullOr(Schema.String)),
  zone: Schema.optional(Schema.String),
  standing: Schema.NullOr(Schema.String),
  stop: Schema.Number,
});
const decodeFingerprint = Schema.decodeUnknownOption(Schema.fromJsonString(Fingerprint));
const decodeIndex = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));
const CarryStamp = Schema.Struct({
  bootId: Schema.String,
  sessionStart: KinWakeupId,
  toolListSha: Schema.NullOr(Schema.String),
  missed: Schema.Boolean,
  compacted: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(Schema.Unknown),
  cursorCaptured: Schema.optional(Schema.Unknown),
});
const CapturedCursor = Schema.Struct({
  changeSeq: Schema.Finite,
  at: Schema.Finite,
  memoryHead: Schema.NonEmptyString,
  chatSeq: Schema.Finite,
  chatId: Schema.NonEmptyString,
  chatChangeSeq: Schema.Finite,
  chatVersions: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      seq: Schema.Finite,
      changeSeq: Schema.Finite,
    }),
  ),
  heldChatChanges: Schema.Array(Schema.Finite),
});
const decodeCursor = Schema.decodeUnknownOption(CapturedCursor);
const decodeStamp = Schema.decodeUnknownOption(Schema.fromJsonString(CarryStamp));

export interface PromptFingerprint {
  readonly standing: string | null;
  readonly index: ReadonlyArray<string> | null;
}

export const fingerprintPrompt = (
  standing: ReadonlyArray<unknown>,
  index: string | undefined,
): PromptFingerprint => ({
  standing: fingerprintJson(standing),
  index:
    index === undefined
      ? null
      : index
          .split("\n")
          .filter((line) => line !== "")
          .map(digest),
});

function changedLines(before: ReadonlyArray<string>, after: ReadonlyArray<string>) {
  const counts = new Map<string, number>();
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of after) counts.set(line, (counts.get(line) ?? 0) - 1);
  return Iterator.from(counts.values()).reduce((total, count) => total + Math.abs(count), 0);
}

interface Wakeup {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: KinWakeupId;
  readonly runId?: RunId | null;
}

const FINGERPRINT_ROWS_LIMIT = 1_000;
const SESSION_HISTORY_LIMIT = 1_000;

const recipeFingerprint = Effect.fn("KinSessionCarry.recipeFingerprint")(function* (
  orgId: KinOrgId,
  enabled: boolean,
) {
  const sql = yield* SqlClient.SqlClient;
  const defaults = yield* sql`SELECT * FROM kin_recipe_defaults WHERE org_id = ${orgId}
    ORDER BY list LIMIT ${FINGERPRINT_ROWS_LIMIT + 1}`;
  const labels = yield* sql`SELECT * FROM kin_recipe_labels WHERE org_id = ${orgId}
    ORDER BY recipe, commit_sha LIMIT ${FINGERPRINT_ROWS_LIMIT + 1}`;
  const baselines =
    yield* sql`SELECT * FROM kin_recipe_label_baselines WHERE org_id = ${orgId} LIMIT 1`;
  if (defaults.length > FINGERPRINT_ROWS_LIMIT || labels.length > FINGERPRINT_ROWS_LIMIT)
    return null;
  // Opening the document workspace can seed it. While carry is off, stamp only the SQL metadata.
  if (!enabled) return fingerprintJson([null, defaults, labels, baselines]);
  const workspace = yield* Effect.serviceOption(KinWorkspace);
  if (Option.isNone(workspace)) return null;
  const catalog = yield* workspace.value.recipes(orgId).pipe(Effect.option);
  return Option.isNone(catalog)
    ? null
    : fingerprintJson([catalog.value, defaults, labels, baselines]);
});

export const carryFacts = Effect.fn("KinSessionCarry.facts")(function* (
  wakeup: Wakeup,
  input: {
    readonly threadId: ThreadId;
    readonly ownerThread: boolean;
    readonly driver: string | undefined;
    readonly model: ModelSelection;
    readonly instructionsSha: string | null;
    readonly bootId: string;
    readonly toolListSha: string | null;
    readonly prompt: PromptFingerprint;
    readonly enabled: boolean;
    readonly now: number;
    readonly stopRevision: number;
    readonly compactAtTokens?: number;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, agentId, wakeupId } = wakeup;
  const { threadId } = input;
  const [lead] = yield* sql<{
    ownerChat: string;
    owner: string;
    name: string;
    domain: string;
    charter: string;
    intro: string;
    level: string;
    levelSince: number;
  }>`
    SELECT l.owner_chat_id AS "ownerChat", a.owner_person_id AS owner, l.name, l.domain, l.charter,
      l.public_intro AS intro, l.level, l.level_since AS "levelSince"
    FROM kin_leads l LEFT JOIN kin_agents a USING (org_id, agent_id)
    WHERE l.org_id = ${orgId} AND l.agent_id = ${agentId} LIMIT 1`;
  const chat = (yield* turnChat(wakeup))?.chatId ?? null;
  const members =
    chat === null
      ? []
      : yield* sql`
    SELECT member_id, principal_kind, person_id, agent_id, role, joined_at
    FROM kin_chat_members WHERE org_id = ${orgId} AND chat_id = ${chat} AND left_at IS NULL
    ORDER BY member_id LIMIT ${FINGERPRINT_ROWS_LIMIT + 1}`;
  const lists = yield* sql`
    SELECT register_id, name, definition_json, archived_at FROM kin_registers
    WHERE org_id = ${orgId} ORDER BY register_id LIMIT ${FINGERPRINT_ROWS_LIMIT + 1}`;
  const budgets = yield* sql`SELECT * FROM kin_money_budgets
    WHERE org_id = ${orgId} ORDER BY budget_id LIMIT ${FINGERPRINT_ROWS_LIMIT + 1}`;
  const recipes = yield* recipeFingerprint(
    orgId,
    input.enabled && input.ownerThread && input.driver === "claudeAgent",
  );
  // oxlint-disable-next-line t3code/kin-zoned-time -- fingerprint the stored owner-zone setting
  const [zone] = yield* sql<{ zone: string }>`SELECT time_zone AS zone FROM kin_trigger_settings
    WHERE org_id = ${orgId} LIMIT 1`;
  const [stop] = yield* sql<{ paused: number }>`
    SELECT paused FROM kin_org_state WHERE org_id = ${orgId} LIMIT 1`;
  const fingerprint = {
    chat,
    model: fingerprintJson(input.model),
    instructions: input.instructionsSha,
    lead: fingerprintJson(lead ?? null),
    members: fingerprintJson(members),
    lists: lists.length > FINGERPRINT_ROWS_LIMIT ? null : fingerprintJson(lists),
    budgets: budgets.length > FINGERPRINT_ROWS_LIMIT ? null : fingerprintJson(budgets),
    recipes,
    zone: fingerprintJson(zone?.zone ?? unsetOwnerZone()),
    standing: input.prompt.standing,
    stop: input.stopRevision,
  };
  const [previous] = yield* sql<{
    wakeupId: KinWakeupId;
    status: string;
    contextTokens: number | null;
    startedAt: number;
    stamp: string | null;
    fingerprint: string | null;
    promptIndex: string | null;
    providerThreadId: string | null;
    ended: number;
  }>`
    SELECT w.wakeup_id AS "wakeupId", w.status, w.carry_json AS stamp,
      w.standing_key AS fingerprint, w.prompt_index AS "promptIndex", w.started_at AS "startedAt",
      w.context_tokens AS "contextTokens", r.provider_thread_id AS "providerThreadId",
      CASE WHEN t.ended_at IS NOT NULL OR t.thread_id IS NULL OR t.chat_id IS NOT NULL
        THEN 1 ELSE 0 END AS ended
    FROM kin_wakeups w
    LEFT JOIN kin_agent_threads t USING (org_id, agent_id, thread_id)
    LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = w.run_id AND r.thread_id = w.thread_id
    WHERE w.org_id = ${orgId} AND w.agent_id = ${agentId} AND w.thread_id = ${threadId}
      AND w.wakeup_id <> ${wakeupId} AND w.kind = 'turn' AND w.status <> 'released'
    ORDER BY w.started_at DESC, w.wakeup_id DESC LIMIT 1`;
  const prior = Option.getOrUndefined(decodeStamp(previous?.stamp));
  const cursor =
    prior?.cursorCaptured === true ? Option.getOrUndefined(decodeCursor(prior.cursor)) : undefined;
  const previousCursor =
    cursor !== undefined &&
    cursor.chatId === chat &&
    cursor.chatVersions.length <= 1_000 &&
    cursor.chatVersions.some(({ id }) => id === chat)
      ? cursor
      : undefined;
  const priorFingerprint = Option.getOrUndefined(decodeFingerprint(previous?.fingerprint));
  const priorIndex = Option.getOrUndefined(decodeIndex(previous?.promptIndex));
  const sessionStart = prior?.sessionStart;
  const [adoptedInSession] =
    wakeup.runId == null || previous?.providerThreadId == null
      ? []
      : yield* sql`
      SELECT 1 FROM orchestration_v2_projection_runs
      WHERE thread_id = ${threadId} AND run_id = ${wakeup.runId}
        AND provider_thread_id = ${previous.providerThreadId} LIMIT 1`;
  const history =
    previous === undefined || prior === undefined
      ? []
      : yield* sql<{
          wakeupId: KinWakeupId;
          lastRequest: number | null;
          contextTokens: number | null;
          draft: number;
          compactedAfterPrevious: number;
        }>`
      SELECT w.wakeup_id AS "wakeupId", w.last_request_at AS "lastRequest",
        w.context_tokens AS "contextTokens",
        CASE WHEN w.kind = 'upkeep' AND (w.started_at, w.wakeup_id) > (${previous.startedAt}, ${previous.wakeupId})
          AND json_extract(w.carry_json, '$.compacted') = 1 THEN 1 ELSE 0 END AS "compactedAfterPrevious",
        EXISTS (SELECT 1 FROM kin_events e WHERE e.org_id = w.org_id AND e.agent_id = w.agent_id
          AND e.wakeup_id = w.wakeup_id AND json_type(e.json, '$.subject.approved') IS NOT NULL) AS draft
      FROM kin_wakeups w
      WHERE w.org_id = ${orgId} AND w.agent_id = ${agentId} AND w.thread_id = ${threadId}
        AND w.wakeup_id <> ${wakeupId}
        AND json_extract(w.carry_json, '$.sessionStart') = ${prior.sessionStart}
      ORDER BY w.last_request_at DESC NULLS LAST, w.started_at DESC, w.wakeup_id DESC
      LIMIT ${SESSION_HISTORY_LIMIT + 1}`;
  let marked = false;
  for (const member of [...history, { wakeupId, draft: 0 }]) {
    if (
      member.draft === 1 ||
      (yield* outsideRead({ orgId, wakeupId: member.wakeupId })) ||
      (yield* turnSensitive(orgId, member.wakeupId))
    ) {
      marked = true;
      break;
    }
  }
  const [approved] = yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${orgId}
    AND agent_id = ${agentId} AND wakeup_id = ${wakeupId}
    AND json_type(json, '$.subject.approved') IS NOT NULL LIMIT 1`;
  const [foreign] =
    previous?.providerThreadId == null
      ? []
      : yield* sql`
    SELECT 1 FROM orchestration_v2_projection_runs r
    WHERE r.thread_id = ${threadId} AND r.provider_thread_id = ${previous.providerThreadId}
      AND r.run_id IS NOT ${wakeup.runId ?? null}
      AND NOT EXISTS (SELECT 1 FROM kin_wakeups w WHERE w.org_id = ${orgId} AND w.agent_id = ${agentId}
        AND w.thread_id = r.thread_id AND w.run_id = r.run_id AND w.wakeup_id <> ${wakeupId})
    LIMIT 1`;
  const last = history[0];
  const gapMs = last?.lastRequest == null ? null : input.now - last.lastRequest;
  const facts = {
    enabled: input.enabled,
    provider: input.driver,
    ownerThread: input.ownerThread && threadId.startsWith("kin:"),
    sameChat:
      chat !== null &&
      chat === lead?.ownerChat &&
      (priorFingerprint === undefined || chat === priorFingerprint.chat),
    previousCompleted:
      previous?.status === "completed" &&
      previous.ended === 0 &&
      previous.providerThreadId !== null &&
      sessionStart !== undefined &&
      history.some((member) => member.wakeupId === sessionStart),
    marked: marked || approved !== undefined,
    foreignRun:
      foreign !== undefined ||
      history.length > SESSION_HISTORY_LIMIT ||
      (wakeup.runId != null && adoptedInSession === undefined),
    gapMs,
    contextTokens: last?.contextTokens ?? null,
    ...(input.compactAtTokens === undefined ? {} : { compactAtTokens: input.compactAtTokens }),
    compactedSince:
      prior?.compacted === true || history.some((member) => member.compactedAfterPrevious === 1),
    sameBoot: input.bootId === prior?.bootId,
    sameModel: fingerprint.model === priorFingerprint?.model,
    sameInstructions:
      fingerprint.instructions !== null &&
      fingerprint.instructions === priorFingerprint?.instructions,
    sameToolList: input.toolListSha !== null && input.toolListSha === prior?.toolListSha,
    sameLead: lead !== undefined && fingerprint.lead === priorFingerprint?.lead,
    sameMembers:
      members.length <= FINGERPRINT_ROWS_LIMIT && fingerprint.members === priorFingerprint?.members,
    sameLists: fingerprint.lists !== null && fingerprint.lists === priorFingerprint?.lists,
    sameBudgets: fingerprint.budgets !== null && fingerprint.budgets === priorFingerprint?.budgets,
    sameRecipes: fingerprint.recipes !== null && fingerprint.recipes === priorFingerprint?.recipes,
    sameZone: fingerprint.zone === priorFingerprint?.zone,
    paused: stop?.paused === 1 || fingerprint.stop !== priorFingerprint?.stop,
    sameStanding:
      fingerprint.standing !== null && fingerprint.standing === priorFingerprint?.standing,
    indexLinesChanged:
      input.prompt.index === null || priorIndex === undefined
        ? CARRY_INDEX_LINES + 1
        : changedLines(priorIndex, input.prompt.index),
    missed: prior?.missed === true,
  } satisfies CarryFacts;
  return {
    facts,
    fingerprint,
    sessionStart: adoptedInSession === undefined ? wakeupId : (sessionStart ?? wakeupId),
    carriedFrom: sessionStart ?? null,
    sessionWakeupIds: [...history.map((member) => member.wakeupId), wakeupId],
    contextTokens: facts.contextTokens,
    previousWakeupId: previous?.wakeupId,
    previousCursor,
  };
});
