# Kin: the end goal

Set by the owner on 10 Nov 2026. Read this before planning, appraising, or cutting scope. It overrides any summary, plan, or review that reads Kin as only a single-owner assistant. Any change to it needs the owner's sign-off.

**Run an entire company from the phone.** Kin is a messaging app, like WhatsApp, where the people and AI agents of a company work together. Think Grok bot plus T3 Code, but for every function of the company, not just coding.

- **A chief of staff for the owner.** A personal lead the owner talks to one-on-one belongs in the app: it remembers, sets reminders, and follows up. It is one part of Kin, not the whole of it.
- **Many leads, in many domains.** Engineering is the first, with Tech lead. Growth strategy, marketing, social media, billing, finance, and any other domain the owner creates each get their own lead.
- **Every kind of chat in one list:**
  - DMs with a lead;
  - DMs with people;
  - groups of the owner and several agents;
  - groups of the owner, other people, and several agents.
- **Teams of people and agents.** Team members join the same group chats. Several agents on different models work in the open without drowning out the people. The groups, levels, floor, and organizations in [DESIGN.md](DESIGN.md) all serve this goal. Don't cut them as "not needed for one user".
- **Members bring their own leads.** "Teammate" and "lead" mean the same thing. Any member can create and customise a lead through a creation form: its name, domain, charter and model. It runs on the main host. Its authority comes from the member who made it, never from the group, and never more than that member has. Self-hosted agents, running on a member's own machine, are deferred.
- **Work goes to T3 threads.** Coding work runs in Claude Code and Codex threads. The lead decides, remembers, and follows up, and the workers do the work.
- **Authority never passes through a model.** Only the owner approves privileged actions, by signing on a device. Nothing a group member or an agent writes becomes an approval.

## Surfaces

- **Mobile:** the brand mark in the top left switches between the T3 coding-session thread list and the Kin chat list. The Kin list holds every lead, DM, and group.
- **Desktop:** the same, plus a setting for which list it opens to.
- **Web:** the same as desktop, wherever it's reasonable.

## Standing choices

- The leads run on Opus, for every reply. Don't switch conversation to a cheaper model to save money or latency without asking the owner.
- Speed matters, but not at the cost of slop.
