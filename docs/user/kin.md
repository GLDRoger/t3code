# Kin

Kin is where your company works together: the owner, co-owners, teammates and AI agents, in one
chat list. Agents are contacts like anyone else. You ask them for things in plain words, and they
keep Tasks, Money, Clients and Docs current for you.

The dock has **Chats**, **Tasks**, **Money**, **Clients** and **Docs**. **Settings** is the gear on
Chats. What you see in each depends on your place in the team; see
[Who sees and does what](#who-sees-and-does-what).

## Getting started

### Joining a team

Someone who runs the company sends you a join link. Open it in a browser, or in the Kin phone app:
on its first screen, tap **I have a join link**. You're in straight away, with your chats and the
places the owner turned on for you.

A join link works once and lasts a week. If yours has expired or was used, ask for a new one. To
add another phone or browser later, ask for a **Link for another device**; the devices you already
use stay signed in.

### Your profile

Open your profile (your name in the Chats list on the web, **Settings** on the phone) to set your
name, skills, time zone and working hours, and in **How to talk to me** how you like agents to
write to you ("short, numbers first, nothing after 8 pm"). Only you can set that line. Agents read
your profile when they decide who should do something, when to message you and how. An agent nudges you about the same thing at most once a day,
inside your hours.

### Adding a teammate (owner and co-owners)

Choose **New**, then **Add teammate**, and give their name. Kin makes a link for you to send; it
doesn't send it for you and won't show it again. Make the link from the address your team uses to
reach Kin, not from `localhost`, or it won't open on anyone else's device.

Each teammate starts as a **Member**. Open them on the **Team** page to make them a **Co-owner**, to
turn on what they can see (Money, Clients, Docs), to choose which agents they can message, or to
**Remove access**.

## Talking to an agent

Open an agent in Chats and write to it as you would to a colleague: "what's late this week?",
"remind me to call Orbit at 4", "draft the November invoice for Acme". It answers in the same chat.

- **Each agent has a character.** Finance is exact and wary of promises, Growth sees upside
  everywhere, Social lives online. An agent has views, says when it disagrees with you, and then
  does what you decide. To change how one sounds, tell it in its chat ("be warmer with me"); it
  rewrites its character and says so in a line. The character is a private doc in **Docs**, and its
  history brings an older one back. A character never changes what an agent may do.
- **It does, then tells.** Inside the company an agent acts and tells you in a line: it moves a
  task, drafts a doc, fixes a record. It asks only what only you know, once, with the default it
  will take. Say "undo it" and it puts back what it just changed. To let it do something without
  asking every time, say so ("Finance may always draft payment reminders"); it remembers.
- **One reply per message.** Each message gets one answer. If the agent starts something longer,
  such as a coding job, it says so and comes back in the chat when there's news.
- **It works with what you can see.** An agent answering you sees only what you may see.
  When a member asks about money, it won't share figures they can't see.
- **Long answers read like a page.** A short reply is a bubble. One with headings, a table or a
  list of several things fills the chat's width, in sections you can fold; on the phone a long one
  opens with **Read more**. A check-in arrives as a brief: a greeting, the date, then only the
  sections that have something in them.
- **Names open what they name.** An agent, a teammate, a client, a project, a task or a document
  number such as INV-1 in a message is a link to it, when you may open it. Touch and hold one on
  the phone, or hover on the web, to see its state first.
- **It asks with cards.** A question with choices, a chart, or something to confirm comes as a card
  in the chat. Tapping an answer answers the agent; it is never an approval.
- **It asks once, and says what it will do.** An agent's question comes with the answer it will go
  with and the day, by default the end of your next working day (until 19:30). If you don't answer
  by then, it goes with that answer and tells you in one line; say "undo it" to reverse. Something
  that would send, post or move money has no such default: it is raised once more the next working
  morning and then waits for you. Another agent won't ask you the same thing while it is open.
  To change the answer before the day, tap another one.
- **It remembers.** Ask it to remember something and it keeps it. "Keep this between us" keeps it
  for the owner alone.
- **It comes back later.** "Remind me Friday at 10" or "check on this in two hours" sets a reminder.
  "Every weekday at 9, tell me what's late" sets a repeating one, shown as a card you can **Run
  now**, **Pause**, **Edit** or **Delete**. Only the owner and co-owners can set repeating ones.
- **It passes things on.** Ask one agent about another's area and it hands it over and tells you
  so. The request shows in the other agent's chat as **Sent by** the first, and the answer comes back
  to the agent you asked, in your chat with it. Ask it to tell a teammate something and the message
  arrives in that teammate's chat, marked as from you.
- **It does engineering work.** An agent that looks after engineering reads your GitHub repos, pull
  requests and checks, reviews pull requests, and starts coding work in T3 Code. It never merges
  without the owner's approval.

**Waiting on you** in Chats collects what needs your answer. An agent's open question shows there with
its default and day, and you can answer it right there.

### What an agent never does without you

An agent prepares; a person decides. These wait for the owner's or a co-owner's **Confirm** on a
card, and typing "yes" in the chat doesn't count:

- sending or replying to an email, or saving a calendar invite;
- posting on any social account, the company's own included, or commenting publicly on someone
  else's repository;
- recording what a bank statement shows (see [Bank and card statements](./kin-statements.md));
- recording money received for a receipt that has no payment yet;
- changing the company details.

Merging a pull request, and changing what an agent may do, need more: an approval with Face ID on a
phone set up under **Settings → Approvals** in the Kin app. Until one is set up, nothing that needs
approval can happen.

## Group chats and the company chat

A group is one chat with any mix of agents and people (owner and co-owners: **New → New group**).
The first agent you pick answers when a message names nobody; write `@` and a name to ask another.
Agents keep to one short message in a group, and don't talk to each other unless you name one.
People in a group can ask its agents to talk things through; only the owner and co-owners can have an agent
start work there. Anyone can give an agent a task in Tasks, and it then works with that person's
access, never more.

In a group, an agent won't show something to people who can't see it. Ask about an invoice there
and it answers you privately instead.

The **company chat** is one group with the whole team and your agents. Turn it on from the **Team**
page and pick which agent answers when nobody is named.

The **team agent**, set on the Team page, is the one every teammate can chat with. It sees only
what each person may see.

### The Team room

Your agents settle things between them in the **Team room**: say "sort it out with Finance", or an
agent opens a discussion itself when something crosses into another agent's area. Only you and
co-owners can read it; teammates never see it, so exact figures can be said there. It is muted and
never counts as unread; a small dot means something new.

- Whose call it is decides. Agents with a stake may speak once uninvited, a decision can be objected
  to once, and every discussion ends: decided, parked, or brought to you.
- You hear the outcome once, as one line in the chat you asked in, with **See how they got there**.
  When an agent started it, the line comes with your next check-in.
- A real disagreement comes as one card with both sides, the Chief of staff's lean and two choices.
- Agents act inside the company, then tell you what they changed. Say "undo it" and they reverse
  those changes. Anything that leaves the company, such as an email, still waits for your Confirm.
- Agents start at most 6 discussions a day and have 2 open at once; a discussion you ask for always
  starts.

## Tasks

Tasks holds everything someone owes someone. **Needs you** at the top is what wants your attention
first: late or stuck work, quiet clients, projects with nothing moving. Choose **I've got it** when
you're handling one.

- **New task** gives a task a title, a due day and someone to do it. Ask an agent instead and it
  writes the task for you.
- **Give to someone else** moves a task to a teammate or an agent. They get it in their Tasks and a
  message in their chat.
- **Hand back** returns a task you were given to the person who gave it, with a reason if you like.
- **Who can see this** says who can see a task. **People on it and the project** is the usual.
  **Only me** makes it private: only the owner, co-owners and whoever has it see it, and it stays
  out of every list, count and search for anyone else. Members can't change it.

Keep amounts, rates and client terms out of task titles and notes. Project people read those; put
the figures in the quote or the invoice.

## Clients and projects

Clients lists each client and their projects, with when you last spoke to them and what's next.
On a client, add contacts and **Log contact** after a call or meeting. If nothing is logged for a
while, the client shows up under Needs you.

A project has a lead, a target day, milestones and its tasks. Its page says whether it's on track,
what's late or stuck, and who's on it. The owner, co-owners and the project's lead add milestones;
everyone on the project sees them. The owner or a co-owner sets the lead under **Project lead**.

A member sees client names and contacts only when the owner turns on **Can see Clients**, and never
what a client is charged or owes. With it on, they also find the projects they're on, under their
clients.

## Money

Money shows what you're owed, what's overdue, who owes you, the next 30 days, cash in the bank and
each month. **Needs attention** at the top lists overdue invoices and renewals coming up.

Most of the bookkeeping happens by telling an agent: "Acme paid ₹48,250 today", "we spent $120 on
hosting", "the GST filing is due on the 20th". It records the entry and answers in a line.

- **Quotes.** Ask for a quote and an agent makes it, numbered, from the company's template. It stays
  a draft until it's sent. When the client says yes, ask for the invoice and it carries the quote's
  lines over.
- **Invoices.** Open an invoice and choose **Make its PDF**. **Record payment** marks money received;
  an invoice paid in full becomes Paid. When an invoice goes overdue, the agent drafts a reminder in
  the same email thread and waits for your Confirm.
- **Receipts.** A receipt is made for each payment. For money received before any invoice, use
  **Add → New receipt**, then **Set against** an invoice of the same client when it's issued.
- **Statements.** Send your bank or card statement in a chat to match its rows to invoices and
  expenses. See [Bank and card statements](./kin-statements.md).
- **Subscriptions.** Tell an agent what you pay for each month or year, with a screenshot or the
  bill, and it keeps them under Subscriptions with what renews next.
- **Budgets and goals.** **Add → Set a budget** or **Add goal**. Goals show to the whole team.
- **Coming-up dates** lists renewals, dues and milestones in one calendar.
- **Currencies.** Every amount stays in its own currency, and totals are kept per currency. Set
  **Exchange rates** to see an "about" figure beside foreign amounts; invoices, receipts and exports
  always keep their own currency.

Money is for the owner and co-owners. A project's lead sees the money filed under the projects they
lead. A member sees no amounts unless the owner turns on **Can see Money**, and then only read-only
figures the owner shares with the team.

Moving from another system? See [Moving your records into Kin](./kin-import.md).

## Docs and how we work

Docs holds what's written for someone to read: briefs, specs, plans, notes, and the PDFs Kin makes.
Each doc is filed under a client, a project or the company; **Unfiled** shows what still needs a
home. Ask an agent to write or change a doc and it edits only the sections that change. Every
version is kept: open **History** to see what changed and, as owner or co-owner, restore an older
one.

A doc is private when it's marked private or it's a quote. Otherwise a project's people can read the
project's docs.

**Playbooks** are how your company works: taking on a client, running a project, chasing money,
reviewing code, and so on. Agents read the right playbook before they act. Change one by saying so
in a chat: "chase invoices after 7 days" and the agent edits the playbook and tells you what
changed. A teammate's suggestion goes to the owner as a question.

Playbooks, like every company doc, are for the whole team to read: everyone with **Can see Docs**,
and the agents working for them. Mark one private to keep it to the owner and co-owners; it then
leaves teammates' lists and search, and agents working for them can't open it either.

## Email and connections

Owners and co-owners connect services under **Settings → Connections**: Google or Microsoft mail,
GitHub, and others. Each mail account reads, and sends only on your Confirm. Tell an agent what an
account is for ("accounts@ is for invoices") and it sends from the right one. A reply always goes
from the account and thread the email is in.

The card shows exactly what will be sent, from which account, to whom. One **Confirm** sends it
once. Only the owner or a co-owner can confirm.

### GitHub

GitHub connects as your own login on your Kin's computer, from the phone or the web: **Settings →
Connections → GitHub → Connect**, then **Get a code**. Tap **Open GitHub**, enter the code, and tap
**Authorize** (grant your organizations if GitHub asks). Kin then shows who it is connected as and
which organizations it reaches. Git and T3 Code on that computer act as you from then on. If you'd
rather not use a code, paste a classic token with `repo`, `read:org` and `workflow` instead.

One account is connected at a time; to switch, **Disconnect** and connect again. Disconnect signs
Kin's computer out; to end it on GitHub too, revoke GitHub CLI under GitHub's Settings →
Applications. If GitHub stops accepting the login, the row says so and offers **Reconnect**.

Once GitHub is connected, an agent works on GitHub as you in chats only you and co-owners can read.
It clones, branches, commits, pushes, opens pull requests and issues, reviews and comments. On your
own and your organizations' repos it just does it; it asks first before acting in someone else's
repo, changing a repo's settings, secrets or access, deleting a repo, or force-pushing or deleting a
main branch. Longer work runs as a task in its own checkout, and when it finishes the agent replies
once with what changed and the pull request. Commits name you as the author and credit the agent
on a `Co-authored-by` line. Say "commit as yourself" (pull requests and comments still show as you) or "don't credit yourself" and it remembers.
Teammates' chats and shared rooms still get no shell: what they ask for comes to you.

To try pull requests in a browser on Ubuntu 23.10 or later, run `t3 browser setup` once as root.

## Check-ins and the weekly brief

A check-in is an agent's regular round: it looks over what needs attention and tells you what
moved. By default the Chief of staff checks in around 9:30 and 15:30 on weekdays, and writes the
**Weekly brief** around 9:00 on Mondays: the week's figures, then which goal is behind, what matters
most, and each decision as a plain question.

Check-in times are loose: "around 9:30" means near then, not on the minute. When you give an agent
a plain time it keeps to it; say "around" or "-ish" for a loose one. A check-in with nothing to
report stays quiet.

Owners and co-owners manage them under **Settings → Check-ins**: add one, turn one off, or **Run
now**. Or say it in a chat: "check in at 11 instead".

**Settings → Company details → Daily limit** caps how much work your agents do each day. Once
they reach it, only your urgent messages run until midnight.

## Memory

**Memory** (owner and co-owners) shows what your agents have learned working with you: preferences,
decisions and lasting facts. Each item is **Only you**, **The team can know**, or **Waiting for your
yes** when an agent thinks the team could know it. Anything about access, money or client terms
stays with the owner. **Forget** an item and agents stop using it; bring it back from **Forgotten**.

## Who sees and does what

A project lead is a member who leads one or more projects. They see what a member sees, plus more
on the projects they lead.

| What                                                 | Owner and co-owners             | Member                                                                           | Project lead, on top                 |
| ---------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------ |
| Chat with agents                                     | All of them                     | The team agent, and agents the owner lets them message                           |                                      |
| Start a group, create an agent, add a teammate       | Yes                             | No                                                                               |                                      |
| Tasks                                                | All, except others' **Only me** | What they hold, made or gave, their projects' and the team's                     |                                      |
| Mark a task **Only me**                              | Yes                             | No                                                                               | Yes                                  |
| Hand back a task                                     | Not needed                      | Yes                                                                              |                                      |
| Money                                                | All                             | Nothing, or read-only shared figures with **Can see Money**                      | The money filed under their projects |
| Record payments, make PDFs and receipts, set budgets | Yes                             | No                                                                               |                                      |
| Clients                                              | All, with what they owe         | Names, contacts and their projects with **Can see Clients**; never what they owe |                                      |
| Add a milestone                                      | Yes                             | No; they see milestones                                                          | On their projects                    |
| Docs                                                 | All                             | Company docs with **Can see Docs**, and their projects' docs                     |                                      |
| Restore an older version of a doc                    | Yes                             | No                                                                               |                                      |
| Confirm an email, statement or receipt; approve      | Yes                             | No                                                                               |                                      |
| Settings, Check-ins, Connections, Memory, Team       | Yes                             | No; their own profile only                                                       |                                      |

Only the owner himself edits a teammate's profile, manages co-owners, and sees his own private
chats. Agents act with the authority of whoever is asking, never more.

## Running Kin on your own host

Kin runs inside the T3 Code server on the owner's computer, and its data stays there. Teammates
reach it the way any remote client does: T3 Connect, your local network, or Tailscale. See
[Remote access](./remote-access.md). Keep the computer on and awake while the team works; see
[Run T3 Code in the background](./background-service.md). Make join links from the address
teammates will use.

To give agents characters you wrote yourself, see
[Setting agents' characters from the host](../operations/kin-characters.md).
