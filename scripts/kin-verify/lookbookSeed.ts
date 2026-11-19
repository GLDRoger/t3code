// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - adds the look book's messages to an invented company.
/**
 * The `lookbook` seed: the lifecycle company plus one of each thing a person reads every day, so
 * every main screen has something on it. Written through real scripted turns and people's RPCs.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { agentOf, database, describeResult, personIdOf, rpcAs, runTurn } from "./actors.ts";
import { type Instance, ORG, readSeed, sleep } from "./instance.ts";
import { VerifyError } from "./rpc.ts";

/** The check-in's answer, as Chief of staff writes the owner's morning brief. */
export const LOOKBOOK_BRIEF = `Good morning Rhea. One thing needs you before lunch.

## Needs you
- Orbit Dental Care's retainer invoice INV-1 (₹47,200) is 12 days late. A reminder to Anita is drafted for your Confirm in Finance's chat.

## Money
- ₹47,200 is owed to us, all of it overdue.
- The Orbit Dental recall dashboard quote (₹3,54,000) is still waiting on them.

## Clients
- Lumen Grove Clinics: no logged contact for 16 days during an open project.

## Work
- Zoya holds three booking-app tasks; the booking flow screens are due first.

## Coming up
- The Orbit Dental retainer renews in 9 days.
`;

const LONG = `Here is where the Lumen Grove booking app stands.

## Done
- The booking flow is sketched and Zoya is drawing the screens.
- The appointments API has a first schema.

## Next
- Patient onboarding copy and walkthrough
- SMS reminder integration, once the clinic picks a provider

## Risks
- The pilot clinics want reminders in two languages; that may move the beta by a week.`;

/** One scripted turn, waited out: a turn's card posts before its reply, which must land first. */
async function turn(instance: Instance, input: Parameters<typeof runTurn>[1]) {
  for (const result of await runTurn(instance, input)) {
    const line = describeResult(result);
    if (!/^[^:]+: ok/.test(line)) throw new VerifyError(`lookbook seed: ${line}`);
  }
  await lookbookSettle(instance);
}

/**
 * Waits until no agent is working or about to (an event due within five minutes, longer than the
 * capture after it), and nothing has changed for longer than two of the pulse's 5 s scans, so
 * what posts next lands in the same order every run.
 */
export async function lookbookSettle(instance: Instance, quietMs = 12_000, timeoutMs = 360_000) {
  const db = database(instance);
  try {
    const deadline = performance.now() + timeoutMs;
    let last = "";
    let since = performance.now();
    while (performance.now() < deadline) {
      const row = db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM kin_wakeups WHERE status = 'running')
              + (SELECT COUNT(*) FROM kin_events WHERE state = 'queued'
                  AND COALESCE(not_before, 0) <= ?) AS working,
            (SELECT COUNT(*) FROM kin_messages) AS messages`,
        )
        .get(Date.now() + 5 * 60_000) as { working: number; messages: number };
      const now = `${row.working}:${row.messages}`;
      if (now !== last) {
        last = now;
        since = performance.now();
      } else if (row.working === 0 && performance.now() - since >= quietMs) return;
      await sleep(250);
    }
  } finally {
    db.close();
  }
  throw new VerifyError(`lookbook seed: agents still working after ${timeoutMs / 1000} s`);
}

export async function lookbookTurns(instance: Instance) {
  await lookbookSettle(instance);
  // Chief of staff: a short reply (the seed's "Wrote the brief."), the brief, a long reply, a short one.
  const chief = agentOf(instance, "chief");
  const chiefChat = readSeed(instance)!.agents.chief!.ownerChatId;
  const owner = await rpcAs(instance, "owner");
  try {
    const saved = (await owner.call("kin.checkIns.save", {
      orgId: ORG,
      agentId: chief.agentId,
      title: "Morning brief",
      what: "Tell me what needs me today, by section.",
      at: "11:00",
      days: [1, 2, 3, 4, 5],
    })) as { checkIns: ReadonlyArray<{ scheduleId: string; title: string }> };
    const scheduleId = saved.checkIns.find((one) => one.title === "Morning brief")?.scheduleId;
    if (scheduleId === undefined) throw new VerifyError("lookbook seed: the check-in wasn't saved");
    const db = database(instance);
    try {
      const replies = () =>
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM kin_messages WHERE chat_id = ? AND author_kind = 'agent'",
            )
            .get(chiefChat) as { n: number }
        ).n;
      const before = replies();
      NodeFS.writeFileSync(NodePath.join(instance.meta, "checkin-reply.md"), LOOKBOOK_BRIEF);
      await owner.call("kin.checkIns.act", { orgId: ORG, scheduleId, action: "run_now" });
      for (let waited = 0; replies() === before; waited += 250) {
        if (waited > 120_000) throw new VerifyError("lookbook seed: the brief never posted");
        await sleep(250);
      }
    } finally {
      db.close();
    }
    await lookbookSettle(instance);
    await turn(instance, {
      agent: "chief",
      person: "owner",
      say: "where is the Lumen Grove app?",
      calls: [{ name: "people_read", arguments: {} }],
      reply: LONG,
    });
    await turn(instance, {
      agent: "chief",
      person: "owner",
      say: "thanks",
      calls: [],
      reply: "Glad to help. I'll look again on Friday.",
    });

    // Finance: a question with a default, then a mail ready for the owner's Confirm.
    await turn(instance, {
      agent: "finance",
      person: "owner",
      say: "anything stale on the board?",
      calls: [
        {
          name: "kin_ask",
          arguments: {
            question: "W-4 has had no update in two weeks. Shall I move it to next Friday?",
            options: [{ label: "Move it" }, { label: "Keep the date" }],
            default: "Move it",
            about: ["W-4"],
            intent: "move W-4 to next Friday",
          },
        },
      ],
      reply: "One question for you.",
    });
    await turn(instance, {
      agent: "finance",
      person: "owner",
      say: "chase Orbit Dental for INV-1",
      calls: [
        {
          name: "kin_connection_call",
          arguments: {
            connection: "hello@ambermill.example",
            tool: "mail_send",
            arguments: {
              to: ["anita@orbitdental.example"],
              subject: "Invoice INV/26-27/004 from Ambermill",
              body: "Hi Anita,\n\nA reminder that the retainer invoice INV/26-27/004 (₹47,200) is now past due. Could you let me know when it will be paid?\n\nThanks,\nRhea",
            },
            reason: "remind Orbit Dental about INV-1",
          },
        },
      ],
      reply: "Here's the reminder, ready to send.",
    });

    // A group with both agents and Zoya, where people talk.
    const group = (await owner.call("kin.groups.create", {
      orgId: ORG,
      title: "Orbit launch",
      agentIds: [chief.agentId, agentOf(instance, "finance").agentId],
      personIds: [personIdOf(instance, "zoya")],
    })) as { chatId: string };
    await owner.call("kin.messages.send", {
      chatId: group.chatId,
      clientMessageId: "lookbook-group-1",
      body: "Kickoff for the Orbit launch is Monday. Zoya, can you bring the brand guide?",
    });
    await lookbookSettle(instance);
    const zoya = await rpcAs(instance, "zoya");
    try {
      await zoya.call("kin.messages.send", {
        chatId: group.chatId,
        clientMessageId: "lookbook-group-2",
        body: "Yes, the second draft is ready. I'll share it before Monday.",
      });
    } finally {
      zoya.close();
    }
    await lookbookSettle(instance);
  } finally {
    owner.close();
  }
}
