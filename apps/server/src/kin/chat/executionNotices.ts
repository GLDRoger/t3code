import { KinChatId, KinMessageId, type KinPendingAction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { KinExecutionNotices, type KinExecutionOutcome } from "../approvals/ExecutionNotices.ts";
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
