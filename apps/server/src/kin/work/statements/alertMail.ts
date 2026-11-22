import type { KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type {
  KinConnectionActivity,
  KinConnections,
} from "../../connections/ConnectionsService.ts";
import { addressesIn } from "../../connections/MailProvider.ts";
import type { OnMail } from "../../pulse/outside.ts";
import type { KinRecords } from "../KinRecords.ts";
import { takeAlerts, threadSeen } from "./bankAlerts.ts";
import { isHdfcAlertSender } from "./hdfcAlerts.ts";

/**
 * A connection's new mail, as the pulse reads it, checked for HDFC alerts: a thread whose sender
 * line is HDFC's alert address, and that Kin hasn't read to its newest mail, is read through the
 * connection's own sign-in and taken message by message. Only counts are logged.
 */

/** Threads read per mailbox per pass; the rest wait for the next. */
const THREADS_PER_PASS = 20;

export const takeAlertMail = Effect.fn("KinBankAlerts.mail")(function* (
  connections: Pick<KinConnections["Service"], "readThread">,
  orgId: KinOrgId,
  activity: Extract<KinConnectionActivity, { readonly _tag: "mail" }>,
) {
  const now = yield* Clock.currentTimeMillis;
  const tally = { threads: 0, recorded: 0, duplicate: 0, rejected: 0 };
  for (const mail of activity.mail) {
    if (tally.threads >= THREADS_PER_PASS) break;
    if (!isHdfcAlertSender(addressesIn(mail.from)[0])) continue;
    const newest = mail.date === null ? Number.NaN : Date.parse(mail.date);
    if (
      Number.isFinite(newest) &&
      (yield* threadSeen(orgId, activity.connectionId, mail.threadId, newest))
    )
      continue;
    tally.threads++;
    const messages = yield* connections.readThread(orgId, activity.connectionId, mail.threadId);
    const taken = yield* takeAlerts(orgId, {
      connectionId: activity.connectionId,
      threadId: mail.threadId,
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
 * The pulse's hook, with the services it writes through. A failure is logged by its kind only:
 * a mail's figures can sit in what failed, and none of them is ever logged.
 */
export const alertsOnMail = Effect.fn("KinBankAlerts.onMail")(function* (
  connections: Pick<KinConnections["Service"], "readThread">,
) {
  const context = yield* Effect.context<SqlClient.SqlClient | KinRecords>();
  const onMail: OnMail = (orgId, activity) =>
    takeAlertMail(connections, orgId, activity).pipe(
      Effect.provide(context),
      Effect.catchCause((cause) => {
        const failed = Cause.squash(cause);
        return Effect.logWarning("Kin couldn't read bank alert mail", {
          orgId,
          connectionId: activity.connectionId,
          failed: failed instanceof Error ? failed.name : "unknown",
        });
      }),
      Effect.asVoid,
    );
  return onMail;
});
