import { KinConnectionId, type KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type { KinConnectionActivity } from "../../connections/ConnectionsService.ts";
import { KinConnections } from "../../connections/ConnectionsService.ts";
import { toolsOf } from "../../connections/ConnectionRows.ts";
import { MAIL_TOOL, addressesIn } from "../../connections/MailProvider.ts";
import type { OnMail } from "../../pulse/outside.ts";
import { KinRecords } from "../KinRecords.ts";
import * as BankAlertReader from "./BankAlertReader.ts";
import {
  ALERT_RETRY_WINDOW,
  bankAlertMailbox,
  retryAlertMailboxes,
  retryAlertThreads,
  takeAlerts,
  threadSeen,
} from "./bankAlerts.ts";
import {
  HELD_ALERT_WINDOW,
  list,
  normalizeAddress,
  sendersOf,
  type ApprovedSender,
} from "./bankSenderRows.ts";
import { candidateGate, type CandidateHint } from "./bankAlertCandidates.ts";
import { senderDmarcPassed } from "./bankAlertMailReading.ts";

/**
 * A connection's new mail, as the pulse reads it, checked for bank alerts: a thread whose sender
 * line is a bank's alert address, and that Kin hasn't read to its newest mail, is read through the
 * connection's own sign-in and taken message by message. Only counts are logged. The activity
 * read is already bounded, and its cursor moves only as far as it read.
 */

const CANDIDATE_THREADS = 3;

export const takeAlertMail = Effect.fn("KinBankAlerts.mail")(function* (
  connections: Pick<KinConnections["Service"], "readThread">,
  orgId: KinOrgId,
  activity: Extract<KinConnectionActivity, { readonly _tag: "mail" }>,
  replayAddress?: string,
) {
  const now = yield* Clock.currentTimeMillis;
  const tally = { threads: 0, recorded: 0, duplicate: 0, rejected: 0 };
  if (!(yield* bankAlertMailbox(orgId, activity.connectionId))) return tally;
  const senders = new Map<string, ApprovedSender>();
  const states = new Map<string, "candidate" | "approved" | "declined" | "removed">();
  if (activity.mail.length > 0) {
    for (const sender of yield* list(orgId)) {
      states.set(sender.address, sender.state);
      if (sender.state === "approved") senders.set(sender.address, sender);
    }
  } else {
    for (const [address, sender] of yield* sendersOf(orgId)) senders.set(address, sender);
  }
  const threads = new Set<string>();
  const candidates = new Map<string, { address: string; hint: CandidateHint | "removed" }>();
  let gates: Effect.Success<ReturnType<typeof candidateGate>> | undefined;
  for (const mail of activity.mail) {
    const address = normalizeAddress(addressesIn(mail.from)[0]);
    if (address === undefined) continue;
    const state = states.get(address);
    if (state === "declined") continue;
    const approved = state === "approved";
    const newest = mail.date === null ? Number.NaN : Date.parse(mail.date);
    if (newest < now - (approved ? ALERT_RETRY_WINDOW : HELD_ALERT_WINDOW)) continue;
    if (
      !approved &&
      (!Number.isFinite(newest) ||
        newest > now ||
        candidates.size >= CANDIDATE_THREADS ||
        !senderDmarcPassed(mail.authResults ?? [], address))
    )
      continue;
    const hint = approved
      ? undefined
      : state === "removed"
        ? "removed"
        : (gates ??= yield* candidateGate(orgId))(address);
    if (!approved && hint === undefined) continue;
    if (
      Number.isFinite(newest) &&
      (yield* threadSeen(orgId, activity.connectionId, mail.threadId, newest))
    )
      continue;
    threads.add(mail.threadId);
    if (hint !== undefined && !candidates.has(mail.threadId))
      candidates.set(mail.threadId, { address, hint });
  }
  const retries = new Set<string>();
  const pending = yield* retryAlertThreads(orgId, activity.connectionId, now, replayAddress);
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

  // One unavailable read stands for the whole pass: the rest wait for the next without a call.
  const reader = yield* BankAlertReader.BankAlertReader;
  let down = false;
  const onceDown = BankAlertReader.BankAlertReader.of({
    read: Effect.fn("KinBankAlertReader.readOnce")((mail) =>
      down
        ? Effect.fail(new BankAlertReader.BankAlertReaderUnavailable())
        : reader.read(mail).pipe(Effect.tapError(() => Effect.sync(() => (down = true)))),
    ),
  });
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
    const candidate = candidates.get(threadId);
    const taken = yield* takeAlerts(orgId, {
      connectionId: activity.connectionId,
      threadId,
      senders,
      ...(candidate === undefined ? {} : { candidate }),
      ...(replayAddress === undefined ? {} : { replayAddress }),
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
    }).pipe(Effect.provideService(BankAlertReader.BankAlertReader, onceDown));
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

const replayHeld = Effect.fn("KinBankAlerts.replayHeld")(function* (
  connections: Pick<KinConnections["Service"], "readThread">,
  orgId: KinOrgId,
  address: string,
) {
  const now = yield* Clock.currentTimeMillis;
  for (const { connectionId } of yield* retryAlertMailboxes(orgId, address, now)) {
    yield* takeAlertMail(
      connections,
      orgId,
      {
        _tag: "mail",
        connectionId: KinConnectionId.make(connectionId),
        since: now,
        until: now,
        account: null,
        cursor: null,
        calendar: [],
        mail: [],
      },
      address,
    );
  }
});

export const startHeldAlertReplay = Effect.fn("KinBankAlerts.startHeldReplay")(function* (
  orgId: KinOrgId,
  address: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* Effect.serviceOption(KinConnections);
  const records = yield* Effect.serviceOption(KinRecords);
  const reader = yield* Effect.serviceOption(BankAlertReader.BankAlertReader);
  // The row's approved state also makes it eligible on a later poll if this host restarts.
  if (Option.isNone(connections) || Option.isNone(records) || Option.isNone(reader)) return;
  yield* sql.afterCommit(
    replayHeld(connections.value, orgId, address).pipe(
      Effect.provideService(KinRecords, records.value),
      Effect.provideService(BankAlertReader.BankAlertReader, reader.value),
      Effect.catchCause(() => Effect.logWarning("Kin couldn't reopen held bank alert mail")),
      Effect.interruptible,
      Effect.forkDetach,
      Effect.asVoid,
    ),
  );
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
  const reader = yield* Effect.serviceOption(BankAlertReader.BankAlertReader);
  const unavailable = BankAlertReader.BankAlertReader.of({
    read: Effect.fn("KinBankAlertReader.missing")(() =>
      Effect.fail(new BankAlertReader.BankAlertReaderUnavailable()),
    ),
  });
  const onMail: OnMail = (orgId, activity) =>
    takeAlertMail(connections, orgId, activity).pipe(
      Effect.as(true),
      Effect.provideService(
        BankAlertReader.BankAlertReader,
        Option.getOrElse(reader, () => unavailable),
      ),
      Effect.provideContext(context),
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
