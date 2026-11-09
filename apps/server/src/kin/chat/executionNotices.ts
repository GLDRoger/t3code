import { KinChatId, KinMessageId, type KinOrgId, type KinPendingAction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { KinExecutionNotices, type KinExecutionOutcome } from "../approvals/ActionExecutor.ts";
import type {
  CredentialHygieneFailure,
  CredentialHygieneReport,
} from "../approvals/CredentialHygiene.ts";
import { KinChatService } from "./KinChatService.ts";

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
}) => {
  const { action } = input;
  const what = subject(action);
  if (input.outcome === "succeeded")
    return action.kind === "merge_pull_request" && action.target._tag === "pull_request"
      ? `Merged ${what} (${action.target.mergeMethod})${input.mergeCommitSha === undefined ? "" : ` as ${input.mergeCommitSha}`}.`
      : action.kind === "delete_branch"
        ? `Deleted ${what}.`
        : `Done: ${what}.`;
  if (input.outcome === "interrupted")
    return `${what} didn't finish, and the approval is spent. Approve a new request to try again.`;
  return `Didn't carry out ${what}: ${input.error ?? "no reason given"}. Approve a new request to try again.`;
};

const FAILURE_TEXT: Record<CredentialHygieneFailure, (report: CredentialHygieneReport) => string> =
  {
    env_token: (report) =>
      report.envTokenNames.length > 0
        ? `${report.envTokenNames.join(", ")} ${report.envTokenNames.length === 1 ? "is" : "are"} set in the server's environment`
        : "T3 takes its GitHub token from the server's environment",
    owner_identity: () => "a GitHub login on this machine is yours",
    non_bot_identity: () => "a GitHub login on this machine isn't the bot's",
    identity_unknown: () => "Kin couldn't read every GitHub login on this machine",
    merge_token_missing: () => "no merge token is saved",
    merge_token_expired: () => "the merge token has expired",
  };

/** Plain text for the owner's chat when the credential check's result changes (spec section 12). */
const credentialCheckBody = (orgId: KinOrgId, report: CredentialHygieneReport) => {
  if (report.passed) {
    return report.warnings.includes("merge_token_expiring")
      ? `Your merge token expires within 7 days. Save a new one with \`node scripts/kin-github-app.ts --merge-token --kin-org ${orgId}\` on the Kin host.`
      : "The credential check passes again, so approved actions can run.";
  }
  const reasons = report.failures.map((failure) => FAILURE_TEXT[failure](report));
  const logins = report.identities.map(({ source, login }) => `${login} (${source})`);
  return [
    `Approved actions won't run until the credential check passes: ${reasons.join("; ")}.`,
    ...(logins.length > 0 ? [`GitHub logins found: ${logins.join(", ")}.`] : []),
    "Kin checks again before each action and every hour.",
  ].join("\n");
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
            body: credentialCheckBody(orgId, report),
          });
        },
        Effect.catchCause((cause) => Effect.logWarning("Kin credential notice not posted", cause)),
      ),
      finished: Effect.fn("KinExecutionNotices.finished")(
        function* (input) {
          const { action } = input;
          const [lead] = yield* sql<{ readonly chatId: string }>`
          SELECT owner_chat_id AS "chatId" FROM kin_leads
          WHERE org_id = ${action.orgId} AND agent_id = ${action.requestedBy.agentId}
          ORDER BY agent_id`;
          if (lead === undefined) {
            yield* Effect.logInfo("Kin action finished", {
              actionId: action.id,
              outcome: input.outcome,
            });
            return;
          }
          yield* chat.notice({
            orgId: action.orgId,
            chatId: KinChatId.make(lead.chatId),
            messageId: KinMessageId.make(`kin-exec:${action.id}`),
            body: executionNoticeBody(input),
          });
        },
        Effect.catchCause((cause) => Effect.logWarning("Kin execution notice not posted", cause)),
      ),
    });
  }),
);
