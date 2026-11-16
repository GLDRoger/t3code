# Setting agents' characters from the host

Each Kin agent has a character: a private company doc it owns (owner level only) that says how it
sounds. Kin writes a default for the five standard agents (Chief of staff, Finance, Tech lead,
Growth, Social) and a starter for any other, the first time the server starts or the agent is
made. The owner changes one in the agent's chat; this command sets one from a Markdown file on the
host instead, for example to bring characters written elsewhere.

```bash
kin lead character                                   # list each agent, its id and its doc
kin lead character --agent <agent-id> --file finance.md
kin lead character --from-dir ~/characters           # every live agent with a matching file
```

- `--from-dir` matches `<domain>.md` first (`chief-of-staff.md`, `finance.md`, `engineering.md`,
  `growth.md`, `social.md`), then the agent's name as a slug (`tech-lead.md`).
- Each set is a new version of the doc, so the doc's history (Docs, **History**) brings the old
  one back. Setting the same text again changes nothing.
- The running server picks the change up on the agent's next turn.

A character file is Markdown. Kin reads three parts of it:

- a `To colleagues:` line, which every other agent sees as this one's one-line description;
- the prose, which is the agent's voice on every turn;
- an optional `## Examples` section, carried only in the owner's own chats, since examples may hold
  figures.

On an installed host, `kin` in a kin shell is that CLI with Kin on, against kin's own data (see
the [host guide](../../ops/kin/host/README.md)). Copy the files somewhere kin can read, then:

```bash
sudo -iu kin kin lead character --from-dir /home/kin/characters
```
