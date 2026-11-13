import {
  KinApprovalError,
  KinChatId,
  KinMessageId,
  KinTrigger,
  type KinOrgId,
  type KinPendingAction,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import type {
  CredentialHygieneFailure,
  CredentialHygieneReport,
} from "../approvals/CredentialHygieneReport.ts";
import {
  KinExecutionNotices,
  KinKeyNotices,
  type KinExecutionOutcome,
  type KinKeyChange,
} from "../approvals/ExecutionNotices.ts";
import { CHIEF_OF_STAFF_DOMAIN } from "../lead/orgLeads.ts";
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

const FAILURE_TEXT: Record<CredentialHygieneFailure, (report: CredentialHygieneReport) => string> =
  {
    env_token: (report) =>
      report.envTokenNames.length > 0
        ? `${report.envTokenNames.join(", ")} ${report.envTokenNames.length === 1 ? "is" : "are"} set in the server's environment`
        : "an environment agents inherit can hand them a GitHub credential",
    owner_identity: () => "a GitHub login on this machine is yours",
    non_bot_identity: () => "a GitHub login on this machine isn't the bot's",
    identity_unknown: () => "Kin couldn't read every GitHub login on this machine",
    merge_token_missing: () => "no merge token is saved",
    merge_token_expired: () => "the merge token has expired",
  };

/** Plain text for the owner's chat when the credential check's result changes (spec section 12). */
export const credentialCheckBody = (orgId: KinOrgId, report: CredentialHygieneReport) => {
  if (report.passed) {
    return report.warnings.includes("merge_token_expiring")
      ? `Your merge token expires within 7 days. Save a new one with \`node scripts/kin-github-app.ts --merge-token --kin-org ${orgId}\` on the Kin host.`
      : "The credential check passes again, so approved actions can run.";
  }
  const failures = report.failures.map((failure) => FAILURE_TEXT[failure](report));
  const logins = report.identities.map(({ source, login }) => `${login} (${source})`);
  return [
    `Approved actions won't run until the credential check passes: ${failures.join("; ")}.`,
    ...(report.reasons.length > 0 ? [`Why: ${report.reasons.join("; ")}.`] : []),
    ...(logins.length > 0 ? [`GitHub logins found: ${logins.join(", ")}.`] : []),
    "Kin checks again before each action and every hour.",
  ].join("\n");
};

const holdText = (holdReason: string) => {
  const split = holdReason.indexOf(": ");
  const reason = split === -1 ? holdReason : holdReason.slice(0, split);
  const failures = split === -1 ? undefined : holdReason.slice(split + 2);
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
    const ownerChat = (orgId: KinOrgId) =>
      sql<{ readonly chatId: string }>`
        SELECT l.owner_chat_id AS "chatId" FROM kin_leads l
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        WHERE l.org_id = ${orgId} AND a.retired_at IS NULL ORDER BY l.agent_id LIMIT 1`;
    const post = Effect.fnUntraced(function* (action: KinPendingAction, body: string) {
      const [lead] = yield* sql<{ readonly chatId: string }>`
        SELECT owner_chat_id AS "chatId" FROM kin_leads
        WHERE org_id = ${action.orgId} AND agent_id = ${action.requestedBy.agentId}
        ORDER BY agent_id`;
      if (lead === undefined) {
        yield* Effect.logInfo("Kin action notice has no chat", { actionId: action.id, body });
        return;
      }
      yield* chat.notice({
        orgId: action.orgId,
        chatId: KinChatId.make(lead.chatId),
        messageId: KinMessageId.make(`kin-exec:${action.id}`),
        audience: "owner",
        body,
      });
    });
    return KinExecutionNotices.of({
      credentialCheck: Effect.fn("KinExecutionNotices.credentialCheck")(
        function* ({ orgId, report, recoveredFrom }) {
          const [lead] = yield* ownerChat(orgId);
          if (lead === undefined) {
            yield* Effect.logWarning("Kin credential check changed with no owner chat", {
              orgId,
              passed: report.passed,
              failures: report.failures.join(","),
            });
            return;
          }
          yield* chat.notice({
            orgId,
            chatId: KinChatId.make(lead.chatId),
            messageId: KinMessageId.make(
              recoveredFrom === undefined
                ? `kin-hygiene:${orgId}:${report.checkedAt}`
                : `kin-hygiene:${orgId}:recovered:${recoveredFrom}`,
            ),
            audience: "owner",
            body: credentialCheckBody(orgId, report),
          });
        },
        Effect.catchCause((cause) => Effect.logWarning("Kin credential notice not posted", cause)),
      ),
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
const decodeZone = Schema.decodeUnknownOption(KinTrigger.fields.timeZone);

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
const noticeTime = (at: number, timeZone: string) =>
  `${new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at)}${timeZone === "UTC" ? " UTC" : ""}`;

export const keyNoticeBody = (input: KinKeyChange, timeZone: string) => {
  const device = `"${kinNoticeDeviceName(input.deviceLabel)}" (${PLATFORM[input.platform] ?? "phone"})`;
  if (input.change === "added")
    return `${device} can now approve for Kin. It was set up on ${noticeTime(input.at, timeZone)}. If that wasn't you, remove it in Settings, then Approvals.`;
  const removed = `${device} can no longer approve for Kin. It was removed on ${noticeTime(input.at, timeZone)}, and anything it approved that hadn't run yet was cancelled.`;
  return input.lastKey
    ? `${removed} No phone can approve now: open Approvals in the Kin app on your phone to set one up.`
    : removed;
};

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
    const ownerChat = Effect.fnUntraced(function* (input: KinKeyChange) {
      const leads = yield* sql<{ chatId: string }>`SELECT l.owner_chat_id AS "chatId"
        FROM kin_leads l
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
          AND a.role = 'lead' AND a.retired_at IS NULL AND a.owner_person_id = ${input.ownerPersonId}
        WHERE l.org_id = ${input.orgId}
        ORDER BY CASE WHEN l.domain = ${CHIEF_OF_STAFF_DOMAIN} THEN 0 ELSE 1 END, a.created_at,
          l.agent_id`;
      const own = yield* sql<{ chatId: string }>`SELECT c.chat_id AS "chatId" FROM kin_chats c
        JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
          AND m.principal_kind = 'person' AND m.person_id = ${input.ownerPersonId}
          AND m.left_at IS NULL
        WHERE c.org_id = ${input.orgId} AND c.archived_at IS NULL
        ORDER BY c.created_at, c.chat_id`;
      for (const { chatId } of [...leads, ...own])
        if (!(yield* chatShared(sql, { orgId: input.orgId, chatId }))) return chatId;
      return undefined;
    });
    return KinKeyNotices.of({
      changed: Effect.fn("KinKeyNotices.changed")(
        function* (input) {
          const [zone] = yield* sql<{ timeZone: string }>`SELECT time_zone AS "timeZone"
            FROM kin_trigger_settings WHERE org_id = ${input.orgId} ORDER BY org_id`;
          const body = keyNoticeBody(
            input,
            Option.getOrElse(decodeZone(zone?.timeZone), () => "UTC"),
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
