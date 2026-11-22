import {
  KinApprovalError,
  KinChatId,
  KinMessageId,
  type KinOrgId,
  type KinPendingAction,
  type KinPersonId,
  formatKinWhen,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  KinExecutionNotices,
  KinKeyNotices,
  type KinExecutionOutcome,
  type KinKeyChange,
} from "../approvals/ExecutionNotices.ts";
import { CHIEF_OF_STAFF_DOMAIN } from "../lead/orgLeads.ts";
import { textLocale, type TextClock } from "../work/companyProfile.ts";
import { ownerZone } from "../work/recordRows.ts";
import { KinChatService } from "./KinChatService.ts";
import { chatShared } from "./sharing.ts";

const subject = (action: KinPendingAction) => {
  switch (action.target._tag) {
    case "pull_request":
      return `${action.target.repo} #${action.target.number}`;
    case "branch":
      return `branch ${action.target.ref} in ${action.target.repo}`;
    default:
      return `${action.kind} ${action.id}`;
  }
};

/** Plain text for the requesting lead's owner chat (spec section 6, step 6). */
const executionNoticeBody = (input: {
  readonly action: KinPendingAction;
  readonly outcome: KinExecutionOutcome;
  readonly mergeCommitSha?: string;
  readonly error?: string;
  readonly note?: string;
}) => {
  const { action } = input;
  const what = subject(action);
  if (input.outcome === "succeeded") {
    const done =
      action.kind === "merge_pull_request" && action.target._tag === "pull_request"
        ? `Merged ${what} (${action.target.mergeMethod})${input.mergeCommitSha === undefined ? "" : ` as ${input.mergeCommitSha}`}.`
        : action.kind === "delete_branch"
          ? `Deleted ${what}.`
          : `Done: ${what}.`;
    return input.note === undefined ? done : `${done} ${input.note}`;
  }
  if (input.outcome === "interrupted")
    return `${what} didn't finish, and the approval is spent. Approve a new request to try again.`;
  return `Didn't carry out ${what}: ${input.error ?? "no reason given"}. Approve a new request to try again.`;
};

const holdText = (holdReason: string) => {
  const [reason, failures] = holdReason.split(": ");
  switch (reason) {
    case "paused":
      return "Kin was paused";
    case "not_configured":
      return "GitHub isn't set up on this Kin host";
    case "roles_unavailable":
      return "Kin couldn't confirm the approver is still an owner";
    case "credential_check_failed":
      return `the credential check failed (${failures ?? "no reason given"})`;
    default:
      return holdReason;
  }
};

/** Posts each result once (the message id is the action's) to the lead's direct chat. */
export const layer = Layer.effect(
  KinExecutionNotices,
  Effect.gen(function* () {
    const chat = yield* KinChatService;
    const sql = yield* SqlClient.SqlClient;
    /**
     * To the owner's chat with the lead, saying who approved when it wasn't him, and to the chat
     * the request came from when that is a co-owner's own, so whoever asked hears the result.
     */
    const post = Effect.fnUntraced(function* (action: KinPendingAction, body: string) {
      const [lead] = yield* sql<{
        readonly chatId: string;
        readonly askedIn: string | null;
        readonly approver: string | null;
      }>`
        SELECT l.owner_chat_id AS "chatId",
          (SELECT t.chat_id FROM kin_agent_threads t WHERE t.org_id = l.org_id
            AND t.thread_id = ${action.requestedBy.threadId}) AS "askedIn",
          (SELECT p.display_name FROM kin_grants g
            JOIN kin_people p ON p.org_id = g.org_id AND p.person_id = g.approver_human_id
            JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
            WHERE g.org_id = l.org_id AND g.action_id = ${action.id}
              AND g.approver_human_id <> a.owner_person_id
            ORDER BY g.revision DESC LIMIT 1) AS approver
        FROM kin_leads l
        WHERE l.org_id = ${action.orgId} AND l.agent_id = ${action.requestedBy.agentId}
        ORDER BY l.agent_id`;
      if (lead === undefined) {
        yield* Effect.logInfo("Kin action notice has no chat", { actionId: action.id, body });
        return;
      }
      yield* chat.notice({
        orgId: action.orgId,
        chatId: KinChatId.make(lead.chatId),
        messageId: KinMessageId.make(`kin-exec:${action.id}`),
        audience: "owner",
        body: lead.approver === null ? body : `${lead.approver} approved this. ${body}`,
      });
      if (lead.askedIn !== null && lead.askedIn !== lead.chatId && lead.approver !== null)
        // The result of their own request, so it may go where they and the lead talk.
        yield* chat.notice({
          orgId: action.orgId,
          chatId: KinChatId.make(lead.askedIn),
          messageId: KinMessageId.make(`kin-exec-asked:${action.id}`),
          audience: "chat",
          body,
        });
    });
    return KinExecutionNotices.of({
      finished: Effect.fn("KinExecutionNotices.finished")(
        function* (input) {
          yield* post(input.action, executionNoticeBody(input));
        },
        Effect.catchCause((cause) => Effect.logWarning("Kin execution notice not posted", cause)),
      ),
      lapsed: Effect.fn("KinExecutionNotices.lapsed")(
        function* ({ action, holdReason }) {
          yield* post(
            action,
            `The approval for ${subject(action)} lapsed before it could run: ${holdText(holdReason)}. Approve a new request to try again.`,
          );
        },
        Effect.catchCause((cause) => Effect.logWarning("Kin lapse notice not posted", cause)),
      ),
    });
  }),
);

const PLATFORM: Record<string, string> = { ios: "iOS", android: "Android" };

/**
 * A phone's reported name, safe inside a quoted notice and a push: letters, digits, spaces,
 * apostrophes and hyphens only, so no markdown, link, domain, mention or control character.
 */
export const kinNoticeDeviceName = (label: string) => {
  const kept = Array.from(label.normalize("NFKC").replace(/[^\p{L}\p{N} '\u2019-]/gu, " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const short = Array.from(kept).slice(0, 40).join("").trim();
  return short === "" ? "A phone" : short;
};

/** Owner-local "Thu 12 Nov, 09:30", or UTC (and saying so) before the owner has set a zone. */
const noticeTime = (at: number, clock: TextClock) =>
  `${formatKinWhen(at, "dayTime", clock)}${clock.zone === "UTC" ? " UTC" : ""}`;

export const keyNoticeBody = (input: KinKeyChange, clock: TextClock) => {
  const device = `"${kinNoticeDeviceName(input.deviceLabel)}" (${PLATFORM[input.platform] ?? "phone"})`;
  if (input.change === "added")
    return `${device} can now approve for Kin. It was set up on ${noticeTime(input.at, clock)}. If that wasn't you, remove it in Settings, then Approvals.`;
  const removed = `${device} can no longer approve for Kin. It was removed on ${noticeTime(input.at, clock)}, and anything it approved that hadn't run yet was cancelled.`;
  return input.lastKey
    ? `${removed} No phone can approve now: open Approvals in the Kin app on your phone to set one up.`
    : removed;
};

/**
 * A chat only the owner reads: the chief of staff's with them, another live lead's, else their
 * first. Undefined when every one is shared.
 */
export const ownerPrivateChat = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
  ownerPersonId: KinPersonId,
) {
  const leads = yield* sql<{ chatId: string }>`SELECT l.owner_chat_id AS "chatId"
    FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      AND a.role = 'lead' AND a.retired_at IS NULL AND a.owner_person_id = ${ownerPersonId}
    WHERE l.org_id = ${orgId}
    ORDER BY CASE WHEN l.domain = ${CHIEF_OF_STAFF_DOMAIN} THEN 0 ELSE 1 END, a.created_at,
      l.agent_id`;
  const own = yield* sql<{ chatId: string }>`SELECT c.chat_id AS "chatId" FROM kin_chats c
    JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
      AND m.principal_kind = 'person' AND m.person_id = ${ownerPersonId}
      AND m.left_at IS NULL
    WHERE c.org_id = ${orgId} AND c.archived_at IS NULL
    ORDER BY c.created_at, c.chat_id`;
  for (const { chatId } of [...leads, ...own])
    if (!(yield* chatShared(sql, { orgId, chatId }))) return KinChatId.make(chatId);
  return undefined;
});

/**
 * One notice per change (the message id is the key's), written in the key change's transaction.
 * It goes to a chat only the owner reads: the chief of staff's, another live lead's, else the
 * owner's first. With none, Settings' recent activity is the record. Either way the change owes
 * the owner a push with the same text, recorded here and sent after the commit.
 */
export const keyNoticesLayer = Layer.effect(
  KinKeyNotices,
  Effect.gen(function* () {
    const chat = yield* KinChatService;
    const sql = yield* SqlClient.SqlClient;
    const ownerChat = (input: KinKeyChange) =>
      ownerPrivateChat(sql, input.orgId, input.ownerPersonId);
    return KinKeyNotices.of({
      changed: Effect.fn("KinKeyNotices.changed")(
        function* (input) {
          const body = keyNoticeBody(
            input,
            yield* Effect.all({
              zone: ownerZone(input.orgId),
              locale: textLocale(input.orgId),
            }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          );
          const messageId = KinMessageId.make(`kin-key-${input.change}:${input.thumbprint}`);
          const chatId = yield* ownerChat(input);
          if (chatId === undefined)
            yield* Effect.logInfo(
              "Kin key notice has no owner-only chat; Settings and a push say it",
              {
                orgId: input.orgId,
                change: input.change,
              },
            );
          else
            yield* chat.notice({
              orgId: input.orgId,
              chatId: KinChatId.make(chatId),
              messageId,
              audience: "owner",
              body,
            });
          yield* sql`INSERT INTO kin_key_pushes ${sql.insert({
            org_id: input.orgId,
            thumbprint: input.thumbprint,
            change: input.change,
            body,
            message_id: chatId === undefined ? null : messageId,
            owed_at: input.at,
          })} ON CONFLICT (org_id, thumbprint, change) DO NOTHING`;
        },
        Effect.mapError(
          () =>
            new KinApprovalError({
              reason: "unavailable",
              message: "Kin couldn't tell you about this change in chat, so it didn't make it.",
            }),
        ),
      ),
    });
  }),
);
