import type { KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type {
  KinConnectionActivity,
  KinConnections,
} from "../../connections/ConnectionsService.ts";
import { toolsOf } from "../../connections/ConnectionRows.ts";
import { MAIL_TOOL, addressesIn } from "../../connections/MailProvider.ts";
import type { OnMail } from "../../pulse/outside.ts";
import type { KinRecords } from "../KinRecords.ts";
import { isBankAlertSender, retryAlertThreads, takeAlerts, threadSeen } from "./bankAlerts.ts";

/**
 * A connection's new mail, as the pulse reads it, checked for bank alerts: a thread whose sender
 * line is a bank's alert address, and that Kin hasn't read to its newest mail, is read through the
 * connection's own sign-in and taken message by message. Only counts are logged. The activity
 * read is already bounded, and its cursor moves only as far as it read.
 */

export const takeAlertMail = Effect.fn("KinBankAlerts.mail")(function* (
  connections: Pick<KinConnections["Service"], "readThread">,
  orgId: KinOrgId,
  activity: Extract<KinConnectionActivity, { readonly _tag: "mail" }>,
) {
  const now = yield* Clock.currentTimeMillis;
  const tally = { threads: 0, recorded: 0, duplicate: 0, rejected: 0 };
  const threads = new Set<string>();
  for (const mail of activity.mail) {
    if (!isBankAlertSender(addressesIn(mail.from)[0])) continue;
    const newest = mail.date === null ? Number.NaN : Date.parse(mail.date);
    if (
      Number.isFinite(newest) &&
      (yield* threadSeen(orgId, activity.connectionId, mail.threadId, newest))
    )
      continue;
    threads.add(mail.threadId);
  }
  const retries = new Set<string>();
  const pending = yield* retryAlertThreads(orgId, activity.connectionId, now);
  if (pending.length > 0) {
    const tools = yield* toolsOf(orgId, activity.connectionId);
    const readable = new Set(
      tools
        .filter((tool) => tool.mode === "read" && tool.removedAt === null)
        .map((tool) => tool.name),
    );
    if (
      readable.has(MAIL_TOOL.read) &&
      (readable.has(MAIL_TOOL.list) || readable.has(MAIL_TOOL.search))
    )
      for (const { threadId } of pending) retries.add(threadId);
  }

  for (const threadId of new Set([...threads, ...retries])) {
    const retryOnly = !threads.has(threadId);
    tally.threads++;
    const read = connections.readThread(orgId, activity.connectionId, threadId);
    const messages = yield* retryOnly
      ? read.pipe(
          Effect.catch((error) =>
            Effect.logWarning("Kin couldn't reopen a bank alert thread", {
              orgId,
              connectionId: activity.connectionId,
              reason: error.reason,
            }).pipe(Effect.as([])),
          ),
        )
      : read;
    if (messages.length === 0) continue;
    const taken = yield* takeAlerts(orgId, {
      connectionId: activity.connectionId,
      threadId,
      retryOnly,
      recheckedThread: retries.has(threadId),
      messages: messages.flatMap((message) =>
        message.body === null
          ? []
          : [
              {
                messageId: message.messageId,
                fromAddress: message.fromAddress,
                subject: message.subject,
                date: message.date,
                authResults: message.authResults,
                text: message.body.text,
              },
            ],
      ),
      now,
    });
    tally.recorded += taken.recorded;
    tally.duplicate += taken.duplicate;
    tally.rejected += taken.rejected;
  }
  if (tally.threads > 0)
    yield* Effect.logInfo("Kin read bank alert mail", {
      orgId,
      connectionId: activity.connectionId,
      ...tally,
    });
  return tally;
});

/**
 * The pulse's hook, with the services it writes through: false when the mail couldn't be read,
 * so the mailbox isn't moved past it. A failure is logged by its kind only: a mail's figures can
 * sit in what failed, and none of them is ever logged.
 */
export const alertsOnMail = Effect.fn("KinBankAlerts.onMail")(function* (
  connections: Pick<KinConnections["Service"], "readThread">,
) {
  const context = yield* Effect.context<SqlClient.SqlClient | KinRecords>();
  const onMail: OnMail = (orgId, activity) =>
    takeAlertMail(connections, orgId, activity).pipe(
      Effect.as(true),
      Effect.provide(context),
      Effect.catchCause((cause) => {
        const failed = Cause.squash(cause);
        return Effect.logWarning("Kin couldn't read bank alert mail", {
          orgId,
          connectionId: activity.connectionId,
          failed: failed instanceof Error ? failed.name : "unknown",
        }).pipe(Effect.as(false));
      }),
    );
  return onMail;
});
