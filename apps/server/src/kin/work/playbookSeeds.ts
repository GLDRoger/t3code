import { kinCharacterSeat, type KinOrgId, type KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Docs from "./docs.ts";

/** The default playbooks: short, plain and meant to be changed. Kin writes them once per company. */
export const PLAYBOOK_SEEDS = [
  {
    slug: "taking-on-a-client",
    seats: ["growth", "finance"],
    title: "Taking on a client",
    body: `# Taking on a client

## When this applies
Someone new wants work from us, or a client wants a new project.

## Steps
1. Talk it through in chat: what they need, by when, the budget, who decides on their side, and how they like to be kept up to date.
2. Write a short PRD as a doc filed under the client: the problem, what we build, what we don't, milestones, risks.
3. Make a quote from the PRD. Ask for an advance on new clients; repeat clients may skip it if the owner says so.
4. Send the quote only on the owner's Confirm. If they haven't answered after the follow-up days below, offer the owner a short nudge.
5. Once they say yes, make the advance invoice. When it's paid, start "Running a project".
6. Note in the client's file what matters about them: who to talk to, how they pay, what they care about.

## Thresholds
\`\`\`kin
quote_follow_up_days: 5
advance_wait_days: 7
\`\`\`

## Who decides
The owner approves every quote and invoice before it goes out.

## Notes
Keep the PRD short; it changes, and the doc history keeps every version.
`,
  },
  {
    slug: "running-a-project",
    seats: ["engineering"],
    title: "Running a project",
    body: `# Running a project

## When this applies
A client project is under way, from the first spec to the last invoice.

## Steps
1. Break the PRD into specs and tasks, each with an owner and a due date. Size them small enough to finish in a few days.
2. Assign by "Assigning work".
3. Keep milestones honest: a heads-up to the owner before a milestone is at risk, not after.
4. A task with no movement for the stalled days below gets a check-in with its owner. Ask what's in the way before reassigning.
5. A task waiting on someone outside the team for too long: say so to the owner, with what we're waiting for.
6. When plans change, replan in the open: say what moved and why, update the tasks and the PRD.
7. At the end, make the final invoice and start "Chasing money".

## Thresholds
\`\`\`kin
due_soon_hours: 24
stalled_after_days: 3
waiting_too_long_days: 5
milestone_heads_up_days: 3
project_quiet_days: 7
\`\`\`

## Who decides
The owner decides scope changes that move price or dates. The team decides how to build.
`,
  },
  {
    slug: "reviewing-and-merging-code",
    seats: ["engineering"],
    title: "Reviewing and merging code",
    body: `# Reviewing and merging code

## When this applies
A pull request is open on one of our repos.

## Steps
1. Every pull request gets a review from someone who didn't write it, and green checks.
2. A change people will see gets clicked through in a running app before it merges.
3. Review comments go back to the author as a short list. Small fixes can be made by the reviewer.
4. A review request left too long: remind the reviewer once, then tell the owner.
5. A pull request open too long: ask its author whether it's still wanted, and close it if not.

## Thresholds
\`\`\`kin
review_waiting_hours: 24
pr_open_too_long_hours: 72
\`\`\`

## Who decides
Merging follows each repo's own rules and permissions; this playbook doesn't change them.
`,
  },
  {
    slug: "chasing-money",
    seats: ["finance"],
    title: "Chasing money",
    body: `# Chasing money

## When this applies
An issued invoice is unpaid past its due date, or a retainer or renewal is coming up.

## Steps
1. An invoice issued without a due date gets one: the client's terms when they name days, else the payment days below.
2. On the due date, nothing. Clients pay late; give it the grace below.
3. After the grace, draft a polite reminder in the invoice's own mail thread and offer it to the owner.
4. A second reminder after the gap below, firmer, naming the amount and the due date.
5. After two reminders, tell the owner in the brief; they call the client themselves.
6. Before a retainer or renewal, give the owner a heads-up and draft the renewal invoice.

## Thresholds
\`\`\`kin
payment_due_days: 15
chase_invoice_after_days: 10
second_reminder_after_days: 7
renewal_heads_up_days: 14
\`\`\`

## Who decides
Every reminder and invoice goes out only on the owner's Confirm. Never change an amount or a due date in a reminder.
`,
  },
  {
    slug: "checking-in-with-clients",
    seats: ["growth"],
    title: "Checking in with clients",
    body: `# Checking in with clients

## When this applies
Any client we work with, during a project and after it.

## Steps
1. Check in every so often (below) with something useful: progress, a decision we need, or a question.
2. A client message waiting for our reply too long: tell whoever owns the client.
3. A client with no contact for the cold days below has gone cold: tell the owner, and suggest what we could offer them next.
4. A meeting's follow-up hours (below) after it, with no outcome noted, ask someone who was in it how it went and what the action items are, in their own chat; note the outcome on the meeting and track the action items as Work.
5. Keep what we learn about the client in their file: what they value, how they decide, how they like to talk.

## Thresholds
\`\`\`kin
client_checkin_days: 14
client_cold_after_days: 30
reply_owed_hours: 24
meeting_follow_up_hours: 2
\`\`\`

## Who decides
Whoever owns the client decides what to say; anything that commits money or dates goes to the owner.
`,
  },
  {
    slug: "assigning-work",
    seats: ["engineering"],
    title: "Assigning work",
    body: `# Assigning work

## When this applies
A new task needs an owner, or someone's load needs rebalancing.

## Steps
1. Match the task to people by role and the skills they listed, then by how much they have open.
2. Nobody takes on more open tasks than the load below without being asked first.
3. Work an agent can do well (drafts, research, code with a clear spec) can go to an agent.
4. Say who you assigned and why, in a line, so people can push back.
5. Overdue work with no word from its owner: ask them first, then offer to take it over or reassign it.

## Thresholds
\`\`\`kin
overloaded_load: 8
\`\`\`

## Who decides
The owner can reassign anything; people can hand back work they can't do.
`,
  },
  {
    slug: "winning-customers",
    seats: ["growth", "social"],
    title: "Winning customers",
    body: `# Winning customers

## When this applies
Finding new customers, working a prospect, and every deal until it is won or lost.

## Steps
1. Who we want: What we sell says who a good customer is. When it doesn't, ask the owner once and work from our best customers meanwhile.
2. Finding them: look where they are (their trade, their area, who they buy from), read their own pages, and add only the ones that fit, as prospects of whoever asked.
3. Before the first call: a short background note on the prospect, fit first, with what we couldn't find marked as not found.
4. A deal gets a plan: who decides, what they care about, which of our offerings and why, the worries to expect and the proof to bring, and the first three steps with dates.
5. After every meeting: note what happened, what they worry about, what each side promised and by when, and the next step. Send what we promised on time.
6. A worry we answered well goes into What we sell, so the next deal starts with it.
7. Every open deal has a next step with a date. A deal quiet for the days below gets a nudge to whoever looks after it.
8. Won: hand over to "Taking on a client". Lost: one line on why, and a date to look again if it's worth it.

## Thresholds
\`\`\`kin
deal_quiet_days: 14
\`\`\`

## Who decides
Whoever looks after a deal decides the next step. Prices, discounts and terms are the owner's. Mail to a prospect goes out only on the Confirm of the person whose mailbox it is.
`,
  },
] as const;

const SEED_ORIGIN = "kin-playbook-seed:";
/** Winning customers, which holds `deal_quiet_days` until the company moves it. */
export const WINNING_CUSTOMERS_ORIGIN = `${SEED_ORIGIN}winning-customers`;

/**
 * Whether an agent in this area works by this playbook, for its page: the owner's own playbooks and
 * the Chief of staff's (or any other area's) take every one; a standard seat takes the seeds for it.
 */
export const playbookForSeat = (originKey: string | null, domain: string) => {
  const seat = kinCharacterSeat(domain);
  if (seat === null || seat === "chief-of-staff") return true;
  const seed = PLAYBOOK_SEEDS.find((one) => `${SEED_ORIGIN}${one.slug}` === originKey);
  return seed === undefined || (seed.seats as ReadonlyArray<string>).includes(seat);
};

/**
 * The default set, once per company: a seed whose origin key exists is never made again, so a
 * playbook the owner archived or rewrote stays as they left it.
 */
export const seedPlaybooks = Effect.fn("KinPlaybooks.seed")(function* (
  orgId: KinOrgId,
  owner: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const made = yield* sql<{ originKey: string }>`SELECT origin_key AS "originKey" FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'docs' AND origin_key LIKE ${`${SEED_ORIGIN}%`}
    ORDER BY origin_key`;
  const have = new Set(made.map((row) => row.originKey));
  let count = 0;
  for (const seed of PLAYBOOK_SEEDS) {
    const originKey = `${SEED_ORIGIN}${seed.slug}`;
    if (have.has(originKey)) continue;
    yield* Docs.create(
      orgId,
      { actor: { _tag: "system" }, via: "import" },
      {},
      {
        title: seed.title,
        body: seed.body,
        owner: { _tag: "person", personId: owner },
        summary: "Kin's default playbook",
        kind: "playbook",
        company: true,
        originKey,
      },
    );
    count += 1;
  }
  return count;
});
