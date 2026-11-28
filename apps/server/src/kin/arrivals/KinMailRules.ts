import {
  KIN_MAIL_RULE_CARD_TYPE,
  KinChatError,
  KinMailRuleCardState,
  type KinWidgetId,
  KinMailRuleCreateInput,
  type KinMailRuleMatch,
  type KinMailRule,
  type KinMailRuleHistory,
  type KinMailRulePreview,
  type KinMailRulePreviewInput,
  type KinMailRuleRef,
  type KinMailRuleResumeInput,
  type KinMailRuleRunNow,
  type KinMailRuleSetLimitInput,
  type KinMailRulesListInput,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { KinConnections } from "../connections/ConnectionsService.ts";
import { looksLikeSignInMail } from "../connections/MailText.ts";
import { DAY_MS } from "../durations.ts";
import { KinEventQueue } from "../lead/KinEventQueue.ts";
import { ownerLevelSql } from "../people/KinAccess.ts";
import { readOwnerZone } from "../work/recordRows.ts";
import { mailRuleContentHash } from "./ruleContent.ts";
import { holdRuleMail, stopQueuedRuleMail } from "./ruleLifecycle.ts";
import { monthlyMailRuleLimit } from "./ruleLimit.ts";
import { recordManualRuleMail, wakeRuleMail, type WakeMail } from "./ruleWake.ts";
import { mailRuleMatchProblem, mailRuleSharedEnding, matchMailRule } from "./ruleMatch.ts";
import {
  badMailRule as badRule,
  checkMailRuleOwner as stillOwner,
  companyMailRuleMailbox as companyMailbox,
  mailRuleDirectLead as directLead,
  mailRuleMatchJson as MatchJson,
  mailRuleOwnerOnly as notAllowed,
  prepareMailRule,
  DEFAULT_MAIL_RULE_CAP,
} from "./ruleDraft.ts";

const PREVIEW_HEADERS = 200;
const RUN_HEADERS = 50;
const KEEP_MS = 30 * DAY_MS;

const failure = (reason: KinChatError["reason"], message: string) =>
  new KinChatError({ reason, message });
const notFound = failure("not_found", "Kin can't find that mail rule.");
const changed = failure(
  "invalid_state",
  "This mail rule was changed outside Kin, so it won't run. Remove it and set it up again.",
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
const decodeMatch = Schema.decodeUnknownOption(MatchJson);
const decodeRefs = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const isChatError = Schema.is(KinChatError);
const isCreate = Schema.is(KinMailRuleCreateInput);
const decodeCard = Schema.decodeUnknownEffect(KinMailRuleCardState);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

type People = ReadonlyArray<PersonIdentity>;
type Method<Input, Result> = (people: People, input: Input) => Effect.Effect<Result, KinChatError>;

export class KinMailRules extends Context.Service<
  KinMailRules,
  {
    readonly createFromTap: (
      people: People,
      input: KinMailRuleCreateInput,
      expectedHash?: string,
    ) => Effect.Effect<KinMailRule, KinChatError>;
    readonly pause: Method<KinMailRuleRef, KinMailRule>;
    readonly setLimit: Method<KinMailRuleSetLimitInput, KinMailRule>;
    readonly resume: Method<KinMailRuleResumeInput, KinMailRule>;
    readonly remove: Method<KinMailRuleRef, KinMailRule>;
    readonly list: Method<KinMailRulesListInput, { readonly rules: ReadonlyArray<KinMailRule> }>;
    readonly history: Method<KinMailRuleRef, KinMailRuleHistory>;
    readonly preview: Method<KinMailRulePreviewInput, KinMailRulePreview>;
    readonly runNow: Method<KinMailRuleRef, KinMailRuleRunNow>;
  }
>()("t3/kin/arrivals/KinMailRules") {}

type RuleRow = Omit<KinMailRule, "match" | "atLimit" | "month" | "setterDemoted" | "lastRanAt"> & {
  readonly demoted: 0 | 1;
  readonly lastStartedAt: number | null;
  readonly matchJson: string;
  readonly contentHash: string;
  readonly month: string | null;
  readonly sourceEvent: string;
  readonly activation: number;
};
type Candidate = WakeMail & {
  readonly connectionId: string;
  readonly messageId: string;
  readonly noticedAt: number;
  readonly class: string | null;
  readonly hasFile: 0 | 1 | null;
  readonly senderCheck: "passed" | "failed" | "not checked" | null;
};

const toPreviewMail = ({ arrivalId, fromAddress, receivedAt }: Candidate) => ({
  arrivalId,
  fromAddress,
  receivedAt,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* KinConnections;
  const queue = yield* KinEventQueue;
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  // Read once here: a caller's context, such as an RPC's, holds only the no-op default.
  const refresh = yield* KinRefreshObserver;
  const zoneFor = (orgId: KinOrgId) =>
    readOwnerZone(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const settle = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    effect.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError((error) => (isChatError(error) ? error : unavailable)),
    );
  const owner = Effect.fn("KinMailRules.owner")(function* (people: People, orgId: KinOrgId) {
    const person = people.find((one) => one._tag === "person" && one.orgId === orgId);
    if (person === undefined) return yield* notAllowed;
    yield* stillOwner(orgId, person.personId);
    return person.personId;
  });
  const rules = sql`SELECT r.org_id AS "orgId", r.rule_id AS "ruleId",
    r.connection_id AS "connectionId", r.match_json AS "matchJson", r.what,
    r.agent_id AS "agentId", r.chat_id AS "chatId", r.said_by AS "saidBy",
    COALESCE(p.display_name, '') AS "setterName", r.source_event AS "sourceEvent", r.activation,
    CASE WHEN p.person_id IS NOT NULL AND p.removed_at IS NULL
      AND NOT ${sql.literal(ownerLevelSql("p.org_id", "p.person_id"))} THEN 1 ELSE 0 END AS demoted,
    r.content_sha256 AS "contentHash", r.state, r.paused_why AS "pausedWhy",
    r.monthly_cap AS "monthlyCap", r.month, r.fired, r.last_wake_at AS "lastWakeAt",
    r.created_at AS "createdAt", r.updated_at AS "updatedAt",
    (SELECT MAX(w.started_at) FROM kin_mail_rule_runs run
      JOIN kin_wakeups w ON w.org_id = run.org_id AND w.wakeup_id = run.wakeup_id
      WHERE run.org_id = r.org_id AND run.rule_id = r.rule_id AND run.outcome IS NOT 'held'
    ) AS "lastStartedAt"
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
      activation: _activation,
      demoted,
      lastStartedAt,
      ...view
    } = row;
    return {
      ...view,
      // The wake's own check (`ruleSetter`): on the team, not owner level.
      ...(demoted === 1 ? { setterDemoted: true as const } : {}),
      ...(lastStartedAt === null ? {} : { lastRanAt: iso(lastStartedAt) }),
      match,
      wordingChanged: match === null,
      ...monthlyMailRuleLimit(row, at, zone),
    } satisfies KinMailRule;
  };
  const view = Effect.fn("KinMailRules.read")(function* (input: KinMailRuleRef) {
    return toView(yield* one(input), yield* Clock.currentTimeMillis, yield* zoneFor(input.orgId));
  });
  const transaction = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    settle(sql.withTransaction(effect));

  const createFromTap = Effect.fn("KinMailRules.createFromTap")(function* (
    people: People,
    input: KinMailRuleCreateInput,
    expectedHash?: string,
  ) {
    const { orgId, connectionId, agentId, chatId, what, tapId } = input;
    const personId = yield* owner(people, orgId);
    if (!isCreate(input)) return yield* badRule;
    const shared = input.match.from.flatMap((sender) =>
      sender.address === undefined ? (mailRuleSharedEnding(sender.domain) ?? []) : [],
    )[0];
    if (shared !== undefined)
      return yield* failure(
        "invalid_state",
        `${shared} is a domain ending that many companies share, so a rule can't match all mail under it. Name the sender's own domain instead.`,
      );
    const { matchJson, contentSha256: hash, monthlyCap } = yield* prepareMailRule(input);
    if (expectedHash !== undefined && hash !== expectedHash) return yield* changed;
    const ruleId = `rule_${mailRuleContentHash(`${personId.length}:${personId}`, tapId)}`;
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
    } else yield* refresh.touch(orgId, "connections");
    return yield* view({ orgId, ruleId });
  }, transaction);

  const markCardsRemoved = Effect.fn("KinMailRules.markCardsRemoved")(function* (
    { orgId, ruleId }: KinMailRuleRef,
    removedAt: string,
  ) {
    const cards = yield* sql<{ widgetId: KinWidgetId }>`SELECT widget_id AS "widgetId"
      FROM kin_widgets WHERE org_id = ${orgId} AND type = ${KIN_MAIL_RULE_CARD_TYPE}
        AND json_extract(state_json, '$.decision.status') = 'on'
        AND json_extract(state_json, '$.decision.ruleId') = ${ruleId}
        AND json_extract(state_json, '$.decision.removedAt') IS NULL`;
    for (const { widgetId } of cards) {
      const found = yield* repo.getWidget({ orgId, widgetId });
      if (Option.isNone(found)) continue;
      const card = found.value;
      const state = yield* decodeCard(card.state);
      if (state.decision.status !== "on") continue;
      const widget = yield* repo.updateWidget({
        ...card,
        audience: "chat",
        expectedRevision: card.revision,
        state: { ...state, decision: { ...state.decision, removedAt } },
        updatedAt: removedAt,
      });
      yield* sql.afterCommit(hub.publish({ type: "widget.updated", orgId, widget }));
    }
  });
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
      const reason = state === "paused" ? "paused" : "removed";
      yield* holdRuleMail(input.orgId, [input.ruleId], "held_paused", reason, now);
      yield* stopQueuedRuleMail(input.orgId, [input.ruleId], reason, now);
      if (state === "removed") yield* markCardsRemoved(input, iso(now));
      yield* refresh.touch(input.orgId, "connections");
    }
    return yield* view(input);
  }, transaction);
  const setLimit = Effect.fn("KinMailRules.setLimit")(function* (
    people: People,
    { orgId, ruleId, monthlyCap }: KinMailRuleSetLimitInput,
  ) {
    yield* owner(people, orgId);
    const ref = { orgId, ruleId };
    const row = yield* one(ref);
    if (row.state === "removed") return yield* notFound;
    if (row.state === "proposed") return yield* notReady;
    if (row.monthlyCap !== monthlyCap) {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`UPDATE kin_mail_rules SET monthly_cap = ${monthlyCap}, updated_at = ${now}
        WHERE org_id = ${orgId} AND rule_id = ${ruleId}`;
      yield* refresh.touch(orgId, "connections");
    }
    return yield* view(ref);
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
      agent_id = ${agentId}, chat_id = ${chatId}, source_event = ${tapId}, updated_at = ${now},
      activation = activation + 1
      WHERE org_id = ${orgId} AND rule_id = ${ruleId}`;
    yield* refresh.touch(orgId, "connections");
    return yield* view(input);
  }, transaction);
  const list = Effect.fn("KinMailRules.list")(function* (
    people: People,
    { orgId, connectionId, removed }: KinMailRulesListInput,
  ) {
    yield* owner(people, orgId);
    const recentRemoval =
      removed === true
        ? sql`r.state = 'removed' AND r.updated_at >= ${(yield* Clock.currentTimeMillis) - KEEP_MS}`
        : sql`r.state != 'removed'`;
    const rows = yield* sql<RuleRow>`${rules} WHERE r.org_id = ${orgId} AND ${recentRemoval}
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
    const since = (yield* Clock.currentTimeMillis) - KEEP_MS;
    type Entry = KinMailRuleHistory["entries"][number];
    type MailEntry = Extract<Entry, { kind: "mail" }>;
    const rows = yield* sql<
      Omit<MailEntry, "kind" | "refs" | "manual"> & {
        class: string;
        refsJson: string | null;
        manual: 0 | 1;
      }
    >`
      WITH recent AS (
        SELECT * FROM kin_arrivals WHERE org_id = ${input.orgId}
          AND connection_id = ${row.connectionId} AND noticed_at >= ${since}
      ), attempts AS (
        SELECT a.arrival_id, r.event_id, r.wakeup_id, r.settled_at,
          CASE WHEN r.outcome = 'held' THEN 'held_paused' ELSE r.state END AS state,
          CASE r.outcome WHEN 'nothing' THEN 'nothing' WHEN 'raised_card' THEN 'draft' END AS outcome,
          NULL AS refs_json, r.hold_reason, r.outcome AS run_outcome, r.manual
        FROM recent a JOIN kin_mail_rule_runs r ON r.org_id = a.org_id
          AND r.arrival_id = a.arrival_id AND r.rule_id = ${row.ruleId}
        UNION ALL
        SELECT a.arrival_id, a.event_id, a.wakeup_id,
          COALESCE(a.rule_held_at, CASE WHEN a.event_id IS NOT NULL THEN a.settled_at END),
          a.rule_state, CASE WHEN a.rule_hold_reason IS NULL AND a.event_id IS NOT NULL THEN a.outcome END,
          CASE WHEN a.rule_hold_reason IS NULL AND a.event_id IS NOT NULL THEN a.refs_json END,
          a.rule_hold_reason, CASE WHEN a.rule_hold_reason IS NOT NULL THEN 'held' END, 0
        FROM recent a WHERE a.class = 'gap' OR (a.rule_id = ${row.ruleId}
          AND a.rule_state IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM kin_mail_rule_runs r WHERE r.org_id = a.org_id
              AND r.event_id = a.event_id AND r.arrival_id = a.arrival_id AND r.manual = 0
          ))
      )
      SELECT a.arrival_id AS "arrivalId", a.from_address AS "fromAddress",
        a.received_at AS "receivedAt", a.noticed_at AS "noticedAt", a.class, r.state, r.outcome,
        r.event_id AS "eventId", r.wakeup_id AS "wakeupId", r.settled_at AS "settledAt",
        r.refs_json AS "refsJson", r.hold_reason AS "holdReason", r.run_outcome AS "runOutcome", r.manual
      FROM attempts r JOIN recent a ON a.arrival_id = r.arrival_id
      ORDER BY a.noticed_at DESC, a.arrival_id DESC, r.settled_at DESC, r.event_id DESC`;
    const entries = rows.map(({ class: kind, refsJson, manual, ...entry }): Entry =>
      kind === "gap"
        ? {
            kind: "gap",
            arrivalId: entry.arrivalId,
            from: entry.receivedAt ?? entry.noticedAt,
            to: entry.noticedAt,
          }
        : {
            kind: "mail",
            ...entry,
            ...(manual === 1 ? { manual: true as const } : {}),
            refs: Option.getOrNull(decodeRefs(refsJson)),
          },
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
      thread_id AS "threadId", COALESCE(rule_mail_key, mail_key) AS "mailKey",
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
    options: { readonly subject?: "defer" },
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
        if (mailRuleMatchProblem(rule.match) !== undefined) return yield* badRule;
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
        { ...counter, monthlyCap: rule.monthlyCap ?? DEFAULT_MAIL_RULE_CAP },
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
      if (row.state !== "on") return yield* notReady;
      const match = checkedMatch(row);
      if (match === undefined) return yield* changed;
      yield* stillOwner(orgId, row.saidBy);
      const mailbox = yield* companyMailbox(orgId, row.connectionId);
      yield* directLead(orgId, row.saidBy, row.agentId, row.chatId);
      return { row, mailbox, filter: { connectionId: row.connectionId, ...match } };
    });
    const { row, filter, eligible } = yield* sql.withTransaction(
      Effect.gen(function* () {
        const { row, filter } = yield* runnable();
        const eligible = (yield* candidates(orgId, filter.connectionId)).filter(
          (candidate) => select(filter, candidate, undefined, { subject: "defer" }) === "match",
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
          select(filter, candidate, header.arrival.subject, {}) === "match"
        ) {
          chosen = candidate;
          break;
        }
      }
    }
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const { row: current, mailbox } = yield* runnable();
        if (
          current.contentHash !== row.contentHash ||
          current.activation !== row.activation ||
          current.agentId !== row.agentId ||
          current.chatId !== row.chatId ||
          current.saidBy !== row.saidBy ||
          current.sourceEvent !== row.sourceEvent ||
          current.state !== row.state
        )
          return yield* changed;
        if (chosen === undefined)
          return {
            status: "no_match",
            message: "No mail in the last 30 days matches this rule.",
          } satisfies KinMailRuleRunNow;
        const arrivalId = chosen.arrivalId;
        const [stored] = yield* sql<Candidate>`SELECT arrival_id AS "arrivalId",
        connection_id AS "connectionId", message_id AS "messageId", thread_id AS "threadId",
        COALESCE(rule_mail_key, mail_key) AS "mailKey", from_address AS "fromAddress", received_at AS "receivedAt",
        noticed_at AS "noticedAt", class, has_file AS "hasFile", sender_check AS "senderCheck"
        FROM kin_arrivals WHERE org_id = ${orgId} AND arrival_id = ${arrivalId}
          AND connection_id = ${current.connectionId}`;
        if (
          stored === undefined ||
          select(filter, stored, undefined, { subject: "defer" }) !== "match"
        )
          return {
            status: "no_match",
            message: "No mail in the last 30 days matches this rule.",
          } satisfies KinMailRuleRunNow;
        const now = yield* Clock.currentTimeMillis;
        const eventId = yield* wakeRuleMail(current, mailbox, stored, [], 0, now, true);
        if (eventId === undefined) return yield* unavailable;
        yield* recordManualRuleMail(current, arrivalId, eventId);
        yield* refresh.touch(orgId, "connections");
        return { status: "queued", arrivalId, eventId } satisfies KinMailRuleRunNow;
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(KinEventQueue, queue),
      ),
    );
  }, settle);

  return KinMailRules.of({
    createFromTap,
    pause: Effect.fn("KinMailRules.pause")((people, input) => turnOff(people, input, "paused")),
    setLimit,
    resume,
    remove: Effect.fn("KinMailRules.remove")((people, input) => turnOff(people, input, "removed")),
    list,
    history,
    preview,
    runNow,
  });
});

export const layer = Layer.effect(KinMailRules, make);
