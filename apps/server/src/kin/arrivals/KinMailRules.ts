import {
  KinChatError,
  KinMailRuleCreateInput,
  KinMailRuleMatch,
  type KinAgentId,
  type KinChatId,
  type KinMailRule,
  type KinMailRuleHistory,
  type KinMailRulePreview,
  type KinMailRulePreviewInput,
  type KinMailRuleRef,
  type KinMailRuleResumeInput,
  type KinMailRuleRunNow,
  type KinMailRulesListInput,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinConnections } from "../connections/ConnectionsService.ts";
import { looksLikeSignInMail } from "../connections/MailText.ts";
import { MAIL_PRESETS } from "../connections/mailProviders.ts";
import { DAY_MS } from "../durations.ts";
import { directKey } from "../lead/LeadAccess.ts";
import { ownerLevelSql } from "../people/KinAccess.ts";
import { readOwnerZone } from "../work/recordRows.ts";
import { mailRuleContentHash } from "./ruleContent.ts";
import { monthlyMailRuleLimit } from "./ruleLimit.ts";
import {
  mailRuleAddress,
  mailRuleDomain,
  mailRulePhrase,
  mailRuleSharedEnding,
  matchMailRule,
} from "./ruleMatch.ts";

const DEFAULT_CAP = 30;
const PREVIEW_HEADERS = 200;
const RUN_HEADERS = 50;
const KEEP_MS = 30 * DAY_MS;

const failure = (reason: KinChatError["reason"], message: string) =>
  new KinChatError({ reason, message });
const notAllowed = failure("not_allowed", "Only the owner or a co-owner can manage mail rules.");
const notFound = failure("not_found", "Kin can't find that mail rule.");
const badRule = failure(
  "invalid_state",
  "Check the sender filters, subject words, instruction and monthly limit.",
);
const changed = failure(
  "invalid_state",
  "This mail rule was changed outside Kin, so it won't run. Remove it and set it up again.",
);
const noMailbox = failure("invalid_state", "Choose a connected company mailbox.");
const noLead = failure(
  "invalid_state",
  "Choose an active lead and your direct chat with that lead.",
);
const notPaused = failure(
  "invalid_state",
  "This mail rule isn't paused, so there's nothing to resume.",
);
const notReady = failure("invalid_state", "Turn on the mail rule before running it.");
const tapUsed = failure(
  "invalid_state",
  "That tap already turned on a different mail rule. Set this one up again.",
);
const oldResume = failure("invalid_state", "Tap Resume again to turn on this mail rule.");
const unavailable = failure("unavailable", "Kin couldn't load or save mail rules. Try again.");
const MatchJson = Schema.fromJsonString(KinMailRuleMatch);
const decodeMatch = Schema.decodeUnknownOption(MatchJson);
const encodeMatch = Schema.encodeEffect(MatchJson);
const decodeRefs = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const isChatError = Schema.is(KinChatError);
const isCreate = Schema.is(KinMailRuleCreateInput);

type People = ReadonlyArray<PersonIdentity>;
type Method<Input, Result> = (people: People, input: Input) => Effect.Effect<Result, KinChatError>;

export class KinMailRules extends Context.Service<
  KinMailRules,
  {
    readonly createFromTap: Method<KinMailRuleCreateInput, KinMailRule>;
    readonly pause: Method<KinMailRuleRef, KinMailRule>;
    readonly resume: Method<KinMailRuleResumeInput, KinMailRule>;
    readonly remove: Method<KinMailRuleRef, KinMailRule>;
    readonly list: Method<KinMailRulesListInput, { readonly rules: ReadonlyArray<KinMailRule> }>;
    readonly history: Method<KinMailRuleRef, KinMailRuleHistory>;
    readonly preview: Method<KinMailRulePreviewInput, KinMailRulePreview>;
    readonly runNow: Method<KinMailRuleRef, KinMailRuleRunNow>;
  }
>()("t3/kin/arrivals/KinMailRules") {}

type RuleRow = Omit<KinMailRule, "match" | "atLimit" | "month"> & {
  readonly matchJson: string;
  readonly contentHash: string;
  readonly month: string | null;
  readonly sourceEvent: string;
};
type Candidate = {
  readonly arrivalId: string;
  readonly connectionId: string;
  readonly messageId: string;
  readonly fromAddress: string | null;
  readonly receivedAt: number | null;
  readonly noticedAt: number;
  readonly class: string | null;
  readonly hasFile: 0 | 1 | null;
  readonly senderCheck: "passed" | "failed" | "not checked" | null;
};

const validMatch = (match: KinMailRuleMatch) =>
  match.from.every((sender) =>
    sender.address !== undefined
      ? mailRuleAddress(sender.address) !== null
      : mailRuleDomain(sender.domain) !== null,
  ) &&
  match.subjectHas.every((text) => {
    const phrase = mailRulePhrase(text);
    return phrase.length >= 2 && phrase.length <= 60;
  });

const toPreviewMail = ({ arrivalId, fromAddress, receivedAt }: Candidate) => ({
  arrivalId,
  fromAddress,
  receivedAt,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* KinConnections;
  const zoneFor = (orgId: KinOrgId) =>
    readOwnerZone(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const settle = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError((error) => (isChatError(error) ? error : unavailable)));
  const owner = Effect.fn("KinMailRules.owner")(function* (people: People, orgId: KinOrgId) {
    const person = people.find((one) => one._tag === "person" && one.orgId === orgId);
    if (person === undefined) return yield* notAllowed;
    yield* stillOwner(orgId, person.personId);
    return person.personId;
  });
  const stillOwner = Effect.fn("KinMailRules.stillOwner")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
  ) {
    const rows = yield* sql`SELECT 1 FROM kin_people p WHERE p.org_id = ${orgId}
      AND p.person_id = ${personId} AND p.removed_at IS NULL
      AND ${sql.literal(ownerLevelSql("p.org_id", "p.person_id"))}`;
    if (rows.length === 0) return yield* notAllowed;
  });
  const companyMailbox = Effect.fn("KinMailRules.companyMailbox")(function* (
    orgId: KinOrgId,
    connectionId: string,
  ) {
    const rows = yield* sql`SELECT 1 FROM kin_connections WHERE org_id = ${orgId}
      AND connection_id = ${connectionId} AND person_id IS NULL AND kind = 'builtin'
      AND preset IN ${sql.in(MAIL_PRESETS)} AND removed_at IS NULL AND paused_at IS NULL
      AND state = 'active'`;
    if (rows.length === 0) return yield* noMailbox;
  });
  const directLead = Effect.fn("KinMailRules.directLead")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
    agentId: KinAgentId,
    chatId: KinChatId,
  ) {
    const rows = yield* sql`SELECT 1 FROM kin_agents a
      JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
      JOIN kin_chats c ON c.org_id = a.org_id AND c.chat_id = ${chatId}
      JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
      WHERE a.org_id = ${orgId} AND a.agent_id = ${agentId}
        AND a.role = 'lead' AND a.retired_at IS NULL
        AND c.kind = 'direct' AND c.direct_key = ${directKey(personId, agentId)}
        AND c.archived_at IS NULL AND m.person_id = ${personId} AND m.left_at IS NULL
        AND EXISTS (SELECT 1 FROM kin_chat_members recipient
          WHERE recipient.org_id = c.org_id AND recipient.chat_id = c.chat_id
            AND recipient.agent_id = ${agentId} AND recipient.left_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM kin_chat_members other
          WHERE other.org_id = c.org_id AND other.chat_id = c.chat_id AND other.left_at IS NULL
          AND ((other.person_id IS NOT NULL AND other.person_id != ${personId})
            OR (other.agent_id IS NOT NULL AND other.agent_id != ${agentId})))`;
    if (rows.length === 0) return yield* noLead;
  });

  const rules = sql`SELECT r.org_id AS "orgId", r.rule_id AS "ruleId",
    r.connection_id AS "connectionId", r.match_json AS "matchJson", r.what,
    r.agent_id AS "agentId", r.chat_id AS "chatId", r.said_by AS "saidBy",
    COALESCE(p.display_name, '') AS "setterName", r.source_event AS "sourceEvent",
    r.content_sha256 AS "contentHash", r.state, r.paused_why AS "pausedWhy",
    r.monthly_cap AS "monthlyCap", r.month, r.fired, r.last_wake_at AS "lastWakeAt",
    r.created_at AS "createdAt", r.updated_at AS "updatedAt"
    FROM kin_mail_rules r LEFT JOIN kin_people p ON p.org_id = r.org_id AND p.person_id = r.said_by`;
  const one = Effect.fn("KinMailRules.one")(function* ({ orgId, ruleId }: KinMailRuleRef) {
    const [row] = yield* sql<RuleRow>`${rules} WHERE r.org_id = ${orgId} AND r.rule_id = ${ruleId}`;
    if (row === undefined) return yield* notFound;
    return row;
  });
  const checkedMatch = (row: RuleRow) =>
    mailRuleContentHash(row.matchJson, row.what) === row.contentHash
      ? Option.getOrUndefined(decodeMatch(row.matchJson))
      : undefined;
  const toView = (row: RuleRow, at: number, zone: string) => {
    const match = checkedMatch(row) ?? null;
    const {
      matchJson: _matchJson,
      contentHash: _contentHash,
      sourceEvent: _sourceEvent,
      ...view
    } = row;
    return {
      ...view,
      match,
      wordingChanged: match === null,
      ...monthlyMailRuleLimit(row, at, zone),
    } satisfies KinMailRule;
  };
  const view = Effect.fn("KinMailRules.read")(function* (input: KinMailRuleRef) {
    return toView(yield* one(input), yield* Clock.currentTimeMillis, yield* zoneFor(input.orgId));
  });
  const transaction = <A, E>(effect: Effect.Effect<A, E>) => settle(sql.withTransaction(effect));

  const createFromTap = Effect.fn("KinMailRules.createFromTap")(function* (
    people: People,
    input: KinMailRuleCreateInput,
  ) {
    const { orgId, connectionId, agentId, chatId, what, tapId } = input;
    const personId = yield* owner(people, orgId);
    if (!isCreate(input) || what.trim() === "") return yield* badRule;
    const shared = input.match.from.flatMap((sender) =>
      sender.address === undefined ? (mailRuleSharedEnding(sender.domain) ?? []) : [],
    )[0];
    if (shared !== undefined)
      return yield* failure(
        "invalid_state",
        `${shared} is a domain ending that many companies share, so a rule can't match all mail under it. Name the sender's own domain instead.`,
      );
    if (!validMatch(input.match)) return yield* badRule;
    const matchJson = yield* encodeMatch(input.match).pipe(Effect.mapError(() => badRule));
    const hash = mailRuleContentHash(matchJson, what);
    const ruleId = `rule_${mailRuleContentHash(`${personId.length}:${personId}`, tapId)}`;
    const monthlyCap = input.monthlyCap ?? DEFAULT_CAP;
    const now = yield* Clock.currentTimeMillis;
    yield* companyMailbox(orgId, connectionId);
    yield* directLead(orgId, personId, agentId, chatId);
    const made = yield* sql`INSERT INTO kin_mail_rules (org_id, rule_id, connection_id, match_json,
      what, agent_id, chat_id, said_by, source_event, content_sha256, state, monthly_cap, created_at, updated_at)
      VALUES (${orgId}, ${ruleId}, ${connectionId}, ${matchJson}, ${what}, ${agentId}, ${chatId},
        ${personId}, ${tapId}, ${hash}, 'on', ${monthlyCap}, ${now}, ${now})
      ON CONFLICT (org_id, rule_id) DO NOTHING RETURNING rule_id`;
    if (made.length === 0) {
      const old = yield* one({ orgId, ruleId });
      if (
        old.contentHash !== hash ||
        old.connectionId !== connectionId ||
        old.saidBy !== personId ||
        old.sourceEvent !== tapId ||
        old.agentId !== agentId ||
        old.chatId !== chatId ||
        old.monthlyCap !== monthlyCap ||
        old.state === "removed"
      )
        return yield* tapUsed;
    }
    return yield* view({ orgId, ruleId });
  }, transaction);

  const turnOff = Effect.fn("KinMailRules.turnOff")(function* (
    people: People,
    input: KinMailRuleRef,
    state: "paused" | "removed",
  ) {
    yield* owner(people, input.orgId);
    const row = yield* one(input);
    if (row.state === "removed" && state !== "removed") return yield* notFound;
    if (row.state !== state) {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`UPDATE kin_mail_rules SET state = ${state},
        paused_why = ${state === "paused" ? "person" : null}, updated_at = ${now}
        WHERE org_id = ${input.orgId} AND rule_id = ${input.ruleId}`;
    }
    return yield* view(input);
  }, transaction);
  const resume = Effect.fn("KinMailRules.resume")(function* (
    people: People,
    input: KinMailRuleResumeInput,
  ) {
    const { orgId, ruleId, agentId, chatId, tapId } = input;
    const personId = yield* owner(people, orgId);
    const row = yield* one(input);
    if (checkedMatch(row) === undefined) return yield* changed;
    if (
      row.state === "on" &&
      row.sourceEvent === tapId &&
      row.saidBy === personId &&
      row.agentId === agentId &&
      row.chatId === chatId
    )
      return yield* view(input);
    if (row.state !== "paused") return yield* notPaused;
    if (row.sourceEvent === tapId) return yield* oldResume;
    yield* companyMailbox(orgId, row.connectionId);
    yield* directLead(orgId, personId, agentId, chatId);
    const now = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE kin_mail_rules SET state = 'on', paused_why = NULL, said_by = ${personId},
      agent_id = ${agentId}, chat_id = ${chatId}, source_event = ${tapId}, updated_at = ${now}
      WHERE org_id = ${orgId} AND rule_id = ${ruleId}`;
    return yield* view(input);
  }, transaction);
  const list = Effect.fn("KinMailRules.list")(function* (
    people: People,
    { orgId, connectionId }: KinMailRulesListInput,
  ) {
    yield* owner(people, orgId);
    const rows = yield* sql<RuleRow>`${rules} WHERE r.org_id = ${orgId} AND r.state != 'removed'
      ${connectionId === undefined ? sql`` : sql`AND r.connection_id = ${connectionId}`}
      ORDER BY r.created_at, r.rule_id`;
    const now = yield* Clock.currentTimeMillis;
    const zone = yield* zoneFor(orgId);
    return { rules: rows.map((row) => toView(row, now, zone)) };
  }, transaction);
  const history = Effect.fn("KinMailRules.history")(function* (
    people: People,
    input: KinMailRuleRef,
  ) {
    yield* owner(people, input.orgId);
    const row = yield* one(input);
    if (checkedMatch(row) === undefined) return yield* changed;
    const since = (yield* Clock.currentTimeMillis) - KEEP_MS;
    type Entry = KinMailRuleHistory["entries"][number];
    type MailEntry = Extract<Entry, { kind: "mail" }>;
    const rows = yield* sql<
      Omit<MailEntry, "kind" | "refs"> & { class: string; refsJson: string | null }
    >`
      SELECT arrival_id AS "arrivalId", from_address AS "fromAddress", received_at AS "receivedAt",
        noticed_at AS "noticedAt", class, rule_state AS state, outcome, event_id AS "eventId",
        wakeup_id AS "wakeupId", settled_at AS "settledAt", refs_json AS "refsJson"
      FROM kin_arrivals WHERE org_id = ${input.orgId} AND connection_id = ${row.connectionId}
        AND noticed_at >= ${since} AND ((rule_id = ${row.ruleId} AND rule_state IS NOT NULL) OR class = 'gap')
      ORDER BY noticed_at DESC, arrival_id DESC`;
    const entries = rows.map(({ class: kind, refsJson, ...entry }): Entry =>
      kind === "gap"
        ? {
            kind: "gap",
            arrivalId: entry.arrivalId,
            from: entry.receivedAt ?? entry.noticedAt,
            to: entry.noticedAt,
          }
        : { kind: "mail", ...entry, refs: Option.getOrNull(decodeRefs(refsJson)) },
    );
    return { entries };
  }, transaction);

  const candidates = Effect.fn("KinMailRules.candidates")(function* (
    orgId: KinOrgId,
    connectionId: string,
  ) {
    const since = (yield* Clock.currentTimeMillis) - KEEP_MS;
    return yield* sql<Candidate>`SELECT arrival_id AS "arrivalId", connection_id AS "connectionId",
      message_id AS "messageId", from_address AS "fromAddress", received_at AS "receivedAt",
      noticed_at AS "noticedAt", class, has_file AS "hasFile", sender_check AS "senderCheck"
      FROM kin_arrivals WHERE org_id = ${orgId} AND connection_id = ${connectionId}
        AND class NOT IN ('gap', 'own', 'sign_in', 'failed_checks') AND noticed_at >= ${since}
        AND COALESCE(received_at, noticed_at) >= ${since}
      ORDER BY COALESCE(received_at, noticed_at) DESC, arrival_id DESC`;
  });

  const select = (
    rule: KinMailRuleMatch & { readonly connectionId: string },
    row: Candidate,
    subject: string | undefined,
    options: { readonly subject?: "defer"; readonly senderCheck?: "manual" },
  ) =>
    matchMailRule(
      rule,
      {
        ...row,
        hasFile: row.hasFile === null ? null : row.hasFile === 1,
        ...(subject === undefined ? {} : { subject }),
      },
      options,
    );

  const preview = Effect.fn("KinMailRules.preview")(function* (
    people: People,
    input: KinMailRulePreviewInput,
  ) {
    const orgId = input.orgId;
    const { rule, match, rows, snapshot } = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* owner(people, orgId);
        const snapshot = "ruleId" in input ? yield* one(input) : undefined;
        const rule =
          snapshot === undefined
            ? input
            : toView(snapshot, yield* Clock.currentTimeMillis, yield* zoneFor(orgId));
        if (!("match" in rule)) return yield* notFound;
        if (snapshot?.state === "removed") return yield* notFound;
        if (rule.match === null) return yield* changed;
        if (!validMatch(rule.match)) return yield* badRule;
        yield* companyMailbox(orgId, rule.connectionId);
        const filter = { connectionId: rule.connectionId, ...rule.match };
        const rows = (yield* candidates(orgId, rule.connectionId)).filter(
          (row) => select(filter, row, undefined, { subject: "defer" }) !== "no_match",
        );
        return { rule, match: rule.match, rows, snapshot };
      }),
    );
    const filter = { connectionId: rule.connectionId, ...match };
    const hasPhrases = match.subjectHas.length > 0;
    const checked = hasPhrases ? rows.slice(0, PREVIEW_HEADERS) : rows;
    const headers =
      hasPhrases && checked.length > 0
        ? yield* connections.arrivals(
            orgId,
            rule.connectionId,
            checked.map((row) => row.messageId),
          )
        : [];
    const zone = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* owner(people, orgId);
        yield* companyMailbox(orgId, rule.connectionId);
        if (snapshot !== undefined) {
          const current = yield* one(snapshot);
          if (
            checkedMatch(current) === undefined ||
            current.contentHash !== snapshot.contentHash ||
            current.state !== snapshot.state ||
            current.monthlyCap !== snapshot.monthlyCap
          )
            return yield* changed;
        }
        return yield* zoneFor(orgId);
      }),
    );
    const subjects = new Map(
      headers.flatMap((header) =>
        header._tag === "read" ? [[header.messageId, header.arrival.subject] as const] : [],
      ),
    );
    const matches: Array<KinMailRulePreview["matches"][number]> = [];
    let counter = { month: "", fired: 0 };
    for (const row of [...checked].reverse()) {
      const subject = subjects.get(row.messageId);
      if (subject !== undefined && looksLikeSignInMail(subject, "")) continue;
      const match = select(filter, row, subject, {});
      if (match === "no_match") continue;
      const limit = monthlyMailRuleLimit(
        { ...counter, monthlyCap: rule.monthlyCap ?? DEFAULT_CAP },
        row.receivedAt ?? row.noticedAt,
        zone,
      );
      const state = match === "match" && limit.atLimit ? "held_cap" : match;
      counter = { month: limit.month, fired: limit.fired + (state === "match" ? 1 : 0) };
      matches.push({ ...toPreviewMail(row), subject: subject ?? null, state });
    }
    return {
      matches: matches.reverse(),
      subjectCheckLimit: hasPhrases ? PREVIEW_HEADERS : null,
      partial: hasPhrases && (rows.length > checked.length || subjects.size < checked.length),
    } satisfies KinMailRulePreview;
  }, settle);

  const runNow = Effect.fn("KinMailRules.runNow")(function* (
    people: People,
    input: KinMailRuleRef,
  ) {
    const { orgId } = input;
    const runnable = Effect.fn("KinMailRules.manualRule")(function* () {
      yield* owner(people, orgId);
      const row = yield* one(input);
      if (row.state !== "on" && row.state !== "paused") return yield* notReady;
      const match = checkedMatch(row);
      if (match === undefined) return yield* changed;
      yield* stillOwner(orgId, row.saidBy);
      yield* companyMailbox(orgId, row.connectionId);
      yield* directLead(orgId, row.saidBy, row.agentId, row.chatId);
      return { row, filter: { connectionId: row.connectionId, ...match } };
    });
    const { row, filter, eligible } = yield* sql.withTransaction(
      Effect.gen(function* () {
        const { row, filter } = yield* runnable();
        const eligible = (yield* candidates(orgId, filter.connectionId)).filter(
          (candidate) =>
            select(filter, candidate, undefined, { subject: "defer", senderCheck: "manual" }) ===
            "match",
        );
        return { row, filter, eligible };
      }),
    );
    let chosen = filter.subjectHas.length === 0 ? eligible[0] : undefined;
    if (filter.subjectHas.length > 0) {
      for (const candidate of eligible.slice(0, RUN_HEADERS)) {
        const [header] = yield* connections.arrivals(orgId, filter.connectionId, [
          candidate.messageId,
        ]);
        if (
          header?._tag === "read" &&
          !looksLikeSignInMail(header.arrival.subject, "") &&
          select(filter, candidate, header.arrival.subject, { senderCheck: "manual" }) === "match"
        ) {
          chosen = candidate;
          break;
        }
      }
    }
    const { row: current } = yield* sql.withTransaction(runnable());
    if (
      current.contentHash !== row.contentHash ||
      current.updatedAt !== row.updatedAt ||
      current.agentId !== row.agentId ||
      current.chatId !== row.chatId ||
      current.saidBy !== row.saidBy ||
      current.sourceEvent !== row.sourceEvent ||
      current.state !== row.state
    )
      return yield* changed;
    const result: KinMailRuleRunNow =
      chosen === undefined
        ? { status: "no_match", message: "No mail in the last 30 days matches this rule." }
        : {
            status: "not_yet",
            arrivalId: chosen.arrivalId,
            message: "Kin can't run mail rules yet. Nothing ran.",
          };
    return result;
  }, settle);

  return KinMailRules.of({
    createFromTap,
    pause: Effect.fn("KinMailRules.pause")((people, input) => turnOff(people, input, "paused")),
    resume,
    remove: Effect.fn("KinMailRules.remove")((people, input) => turnOff(people, input, "removed")),
    list,
    history,
    preview,
    runNow,
  });
});

export const layer = Layer.effect(KinMailRules, make);
