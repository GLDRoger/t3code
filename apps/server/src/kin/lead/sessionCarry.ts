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
  readonly sameBoot: boolean;
  readonly sameModel: boolean;
  readonly sameInstructions: boolean;
  readonly sameToolList: boolean;
  readonly sameLead: boolean;
  readonly sameMembers: boolean;
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
                              : facts.paused
                                ? "paused"
                                : !facts.sameStanding
                                  ? "standing"
                                  : facts.indexLinesChanged > CARRY_INDEX_LINES
                                    ? "index"
                                    : facts.missed
                                      ? "missed"
                                      : undefined;
  return reason === undefined ? { carry: true as const } : { carry: false as const, reason };
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
});
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
    WHERE l.org_id = ${orgId} AND l.agent_id = ${agentId}`;
  const chat = (yield* turnChat(wakeup))?.chatId ?? null;
  const members =
    chat === null
      ? []
      : yield* sql`
    SELECT member_id, principal_kind, person_id, agent_id, role, joined_at
    FROM kin_chat_members WHERE org_id = ${orgId} AND chat_id = ${chat} AND left_at IS NULL
    ORDER BY member_id`;
  const [stop] = yield* sql<{ paused: number }>`
    SELECT paused FROM kin_org_state WHERE org_id = ${orgId}`;
  const fingerprint = {
    chat,
    model: fingerprintJson(input.model),
    instructions: input.instructionsSha,
    lead: fingerprintJson(lead ?? null),
    members: fingerprintJson(members),
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
  const priorFingerprint = Option.getOrUndefined(decodeFingerprint(previous?.fingerprint));
  const priorIndex = Option.getOrUndefined(decodeIndex(previous?.promptIndex));
  const sessionStart = prior?.sessionStart;
  const [adoptedInSession] =
    wakeup.runId == null || previous?.providerThreadId == null
      ? []
      : yield* sql`
      SELECT 1 FROM orchestration_v2_projection_runs
      WHERE thread_id = ${threadId} AND run_id = ${wakeup.runId}
        AND provider_thread_id = ${previous.providerThreadId}`;
  const history =
    previous === undefined || prior === undefined
      ? []
      : yield* sql<{
          wakeupId: KinWakeupId;
          lastRequest: number | null;
          contextTokens: number | null;
          draft: number;
        }>`
      SELECT w.wakeup_id AS "wakeupId", w.last_request_at AS "lastRequest",
        w.context_tokens AS "contextTokens",
        EXISTS (SELECT 1 FROM kin_events e WHERE e.org_id = w.org_id AND e.agent_id = w.agent_id
          AND e.wakeup_id = w.wakeup_id AND json_type(e.json, '$.subject.approved') IS NOT NULL) AS draft
      FROM kin_wakeups w
      WHERE w.org_id = ${orgId} AND w.agent_id = ${agentId} AND w.thread_id = ${threadId}
        AND w.wakeup_id <> ${wakeupId}
        AND json_extract(w.carry_json, '$.sessionStart') = ${prior.sessionStart}
      ORDER BY w.last_request_at DESC NULLS LAST, w.started_at DESC, w.wakeup_id DESC`;
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
    foreignRun: foreign !== undefined,
    gapMs,
    sameBoot: input.bootId === prior?.bootId,
    sameModel: fingerprint.model === priorFingerprint?.model,
    sameInstructions:
      fingerprint.instructions !== null &&
      fingerprint.instructions === priorFingerprint?.instructions,
    sameToolList: input.toolListSha !== null && input.toolListSha === prior?.toolListSha,
    sameLead: lead !== undefined && fingerprint.lead === priorFingerprint?.lead,
    sameMembers: fingerprint.members === priorFingerprint?.members,
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
    contextTokens: last?.contextTokens ?? null,
  };
});
