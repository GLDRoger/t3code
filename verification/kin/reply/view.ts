type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Vars = Record<string, Value>;

const list = (value: Value | undefined): Value[] => (Array.isArray(value) ? value : []);
const first = (vars: Vars, name: string) => list(vars[name])[0];

export const title = "Your message to an agent, and what comes back";

export const guide =
  "Each box is where your message to an agent stands, as you would see it in your chat. Each arrow is something that happens: you send, a trigger (a check-in, a GitHub event, a pulse fact) queues an event instead, the agent starts on it, writes (held until its turn ends), writes the same answer again, sends its message itself, ends its turn quietly with kin_skip, posts a chart, thinks, sends you a message for someone else (a nudge or relay), you press Stop, its run ends and what it held posts, its turn ends or fails, a turn a trigger started is asked once to send what it wrote, someone joins the chat while it works, you are made a member while it works, or Kin restarts. Red boxes are where a rule below breaks. The model covers two messages from you, four tries at starting, one restart (the turn lost or picked up again), a floor that can close, a Stop, and up to two people joining mid-turn; it follows your first message, a question or request; your second is a reaction or another agent's answer, which may need no reply, or a trigger's event, whose turn speaks only through kin_send. “Working…” shows while the agent works on it and clears when the turn ends.";

export const rules: Record<string, string> = {
  NeverTwo:
    "Each message you send gets at most one reply or one plain failure line, never two. A reply in several bubbles is one reply.",
  NoteOnlyForBrokenPromise:
    "After a reply, a failure adds at most one short line, and only to name something the reply promised that did not happen.",
  NeverReasoning: "The agent's private reasoning never shows up as its reply.",
  NeverDiagnostic: "A failed run’s terminal provider error never becomes the agent’s posted reply.",
  SaidOnce:
    "The agent's reply says its answer once, even when it writes the answer again after using a tool.",
  RelayLands: "A nudge or relay the agent sends you always lands in your chat, whatever the floor.",
  AskedBeforeSilence:
    "When an agent's turn ends without the words your message waited for (it only thought them, or only posted a chart or file), it is asked for them once, unless Kin held its reply back because someone joined and said so in the chat, you pressed Stop, or your message was a reaction or another agent's answer the agent ended quietly with kin_skip.",
  MovedOnce:
    "When someone joins while the agent works and its reply is held back, your message goes to a fresh turn at most once.",
  NeverToOldAudience:
    "Once someone else joined the chat, nothing the agent wrote for you alone posts there.",
  HeldToTheEnd:
    "The agent's reply appears only once its turn has ended, never piece by piece while it still works. A message the agent sends itself goes out when it sends it.",
  AllOrNone:
    "A reply in several bubbles appears whole or not at all, even if Kin restarts while posting it.",
  StopPostsNothing:
    "Once you press Stop, nothing the agent had written for your message is posted.",
  OneRing:
    "A reply in several bubbles notifies you once, with its first bubble; the others show quietly.",
  EveryMessageAnswered:
    "Every message you send ends in a reply, a plain failure line, a chart or file whose agent was asked for its line, or your own Stop, never silence, even when the agent sent you a nudge or relay meanwhile. Only a reaction or another agent's answer that needs no reply may end with the agent's kin_skip.",
  LineClears: '"Working…" (the agent\'s line) always clears.',
  TriggerOnlySends:
    "In a turn a trigger started, only the agent's kin_send reaches the chat; text it writes without sending posts nothing.",
  NudgeOnce:
    "A turn a trigger started that wrote text and sent nothing is asked once to send it or end with kin_skip, never twice.",
};

export const variants = [
  {
    name: "reasoning-posted",
    breaks: "NeverReasoning",
    what: "the thinking filter (isAnswer) is removed",
  },
  {
    name: "diagnostic-posted",
    breaks: "NeverDiagnostic",
    what: "the provider’s terminal diagnostic is posted as an answer",
  },
  {
    name: "relay-through-floor",
    breaks: "RelayLands",
    what: "a relay goes through the floor's grant instead of admitToPerson",
  },
  {
    name: "relay-counts",
    breaks: "EveryMessageAnswered",
    what: "a nudge or relay to the asker counts as their reply (the code before this change)",
  },
  {
    name: "partway-after-reply",
    breaks: "NeverTwo",
    what: "a turn that fails after its reply still says it stopped partway (the code before this change)",
  },
  {
    name: "requeue-replied",
    breaks: "NeverTwo",
    what: "a restart puts a message that already has its reply back in the queue (the code before this change)",
  },
  {
    name: "repeat-posted",
    breaks: "SaidOnce",
    what: "an answer written again after a tool call extends the reply (no `repeats` check)",
  },
  {
    name: "chart-is-answer",
    breaks: "AskedBeforeSilence",
    what: "a chart or file alone counts as the reply, so nobody asks for its line (the code before this change)",
  },
  {
    name: "no-rescue",
    breaks: "AskedBeforeSilence",
    what: "a turn that ends owing words goes straight to “didn't reply” without asking",
  },
  {
    name: "requeue-again",
    breaks: "MovedOnce",
    what: "a held-back reply moves its message to a fresh turn every time, without the `_audienceMoved` flag",
  },
  {
    name: "requeue-after-work",
    breaks: "NeverTwo",
    what: "a held-back reply moves its messages to a fresh turn even after the turn did something visible, and the turn's end requeues the one it already replied to",
  },
  {
    name: "reply-after-join",
    breaks: "NeverToOldAudience",
    what: "the reply posts after someone joined, as the turn's private prompt wrote it",
  },
  {
    name: "line-not-ended",
    breaks: "NeverTwo",
    what: "the join's held-back line posts but the turn's unanswered asks are not ended (no `endLostToJoin`, the code before this change)",
  },
  {
    name: "aborted-requeues-replied",
    breaks: "NeverTwo",
    what: "a turn stopped because its asker was made a member puts a message that already has its reply back in the queue (the code before this change)",
  },
  {
    name: "join-expires-silently",
    breaks: "EveryMessageAnswered",
    what: "a join expires the asks waiting in the chat and posts no line (no `stoppedLines`)",
  },
  {
    name: "posts-mid-turn",
    breaks: "HeldToTheEnd",
    what: "reply text posts as the agent writes it, while its run still works (the code before this change)",
  },
  {
    name: "bubble-first",
    breaks: "AllOrNone",
    what: "the flush posts bubble 1 on its own commit, before the transaction holding the rest",
  },
  {
    name: "stop-flushes",
    breaks: "StopPostsNothing",
    what: "a run the person stopped still posts what it held (the code before `85cc2bbd3c`)",
  },
  {
    name: "steer-after-stop",
    breaks: "StopPostsNothing",
    what: "a message sent after Stop is steered into the stopped wake-up, whose adopted run then posts what the stopped run held (the code at `85cc2bbd3c`)",
  },
  {
    name: "bubble-two-rings",
    breaks: "OneRing",
    what: "bubble 2 of a reply group is not silent, so it pushes and counts unread too",
  },
  {
    name: "requeue-reposts",
    breaks: "NeverTwo",
    what: "a restart that picks the turn up again posts its reply group a second time (no per-bubble key or stored-body check)",
  },
  {
    name: "text-after-send",
    breaks: "NeverTwo",
    what: "after a successful send, the text the agent also wrote posts as a second message",
  },
  {
    name: "trigger-text-posts",
    breaks: "TriggerOnlySends",
    what: "a turn a trigger started posts its plain text at the end, as before the switch (no `dropText`)",
  },
  {
    name: "send-forgotten-on-restart",
    breaks: "NeverTwo",
    what: "a restart after a send forgets its receipt, so the resumed wake-up posts the text held beside the send as a second message (no stored `sentThrough`)",
  },
  {
    name: "send-after-stop",
    breaks: "StopPostsNothing",
    what: "a send lands after your Stop committed (no `wasStopped` check in the send's transaction)",
  },
  {
    name: "nudge-loops",
    breaks: "NudgeOnce",
    what: "a turn a trigger started is asked to send again after the first nudge (no `nudged` mark)",
  },
  {
    name: "skip-silences",
    breaks: "EveryMessageAnswered",
    what: "kin_skip is accepted, and counted as the answer, while you wait on words (no `quietAllowed` refusal)",
  },
  {
    name: "line-stays",
    breaks: "LineClears",
    what: "the end of a turn no longer clears the agent's line",
  },
];

export const state = (vars: Vars) => {
  const ev = first(vars, "ev");
  const told = Number(first(vars, "replies")) + Number(first(vars, "fails"));
  if (told > 1) return "Answered twice";
  if (ev === "none") return "Nothing sent yet";
  if (first(vars, "stopped") === true && told === 0) return "You stopped it";
  if (first(vars, "letGo") === true && told === 0 && ev === "done")
    return "Ended quietly, no reply";
  if (told === 1 && ev === "queued") return "Answered, yet back in the queue";
  if (told === 1 && ev === "claimed" && first(vars, "covered") === false)
    return "Answered, and the agent starts on it again";
  if (told === 1) return Number(first(vars, "replies")) === 1 ? "Replied" : "Failure line shown";
  if (ev === "queued")
    return Number(first(vars, "tries")) > 0 ? "Waiting to try again" : "Sent, waiting";
  if (ev === "claimed")
    return first(vars, "held") === true && vars["ended"] !== "no"
      ? "Turn over, its reply about to post"
      : "Agent working on it (Working…)";
  return "No answer";
};

export const step = (action: string, from: Vars, to: Vars) => {
  switch (action) {
    case "PersonSends":
      return first(from, "ev") === "none" ? "You send a message" : "You send another message";
    case "TriggerFires":
      return "A trigger queues an event for the agent";
    case "Nudge":
      return "The turn ends with text no one got; the agent is asked once to send it or skip";
    case "Claim":
      return "The agent starts on it";
    case "Steer":
      return "Your next message joins the running turn";
    case "LeadWrites":
      return "The agent writes its reply (held until the turn ends)";
    case "LeadSends":
      return "The agent sends you its message itself";
    case "Skip":
      return "The agent ends its turn quietly with kin_skip";
    case "PersonStops":
      return "You press Stop";
    case "RunEnds":
      return to["ended"] === "interrupted"
        ? "Its run ends, stopped"
        : to["ended"] === "failed"
          ? "Its run fails"
          : "Its run ends";
    case "Flush":
      return "Its reply posts, all bubbles at once";
    case "RunStopped":
      return "The stopped turn ends; nothing it held is posted";
    case "LeadRepeats":
      return "The agent writes its answer again after using a tool";
    case "LeadShows":
      return "The agent posts a chart or file and says nothing";
    case "TerminalDiagnostic":
      return "The provider writes its terminal error in the transcript";
    case "LeadThinks":
      return "The agent thinks";
    case "LeadNudgesAsker":
      return "The agent sends you a nudge or a relay";
    case "LeadWorks":
      return "The agent uses a tool";
    case "LeadKeepsPromise":
      return "The agent posts the card or hand-over its reply promised";
    case "FloorCloses":
      return "The floor closes";
    case "SomeoneJoins":
      return "Someone joins the chat while the agent works";
    case "JoinStops":
      return from["wake"] === "running"
        ? "Someone else joins; the agent's turn is stopped and the chat is told once"
        : "Someone else joins; the chat is told once your waiting message won't be answered";
    case "MadeMember":
      return "You are made a member while the agent works; its turn is stopped";
    case "ReplyHeldBack":
      return to["aborted"] === true
        ? "Its reply is held back for the join; nothing visible yet, so a fresh turn will answer"
        : "Its reply is held back for the join; the chat is told once";
    case "RunCompletes":
      if (from["aborted"] === true)
        return "The turn ends; a message it had not answered goes to a fresh turn";
      if (from["noticed"] === true) return "The turn ends; nothing more is said";
      return Number(first(to, "fails")) > Number(first(from, "fails"))
        ? "The turn ends; asked once more, no reply: “didn't reply”"
        : Number(first(to, "replies")) > Number(first(from, "replies"))
          ? "The turn ends; asked once more, the agent replies"
          : first(to, "asked") === true && first(from, "asked") !== true
            ? "The turn ends; asked for a line, the agent leaves its chart as it is"
            : "The turn ends";
    case "RunFails":
      if (from["aborted"] === true)
        return "The turn fails; a message it had not answered goes to a fresh turn";
      if (Number(first(to, "notes")) > Number(first(from, "notes")))
        return "The turn fails before what the reply promised: one line names it";
      if (first(to, "ev") === "done")
        return "The turn fails after the reply: logged, nothing posted";
      return Number(first(to, "fails")) > Number(first(from, "fails"))
        ? Number(first(to, "tries")) >= 4
          ? "It fails a fourth time: “won't try again”"
          : "The turn fails after doing something: “stopped partway”"
        : "The turn fails to start: “trying again”";
    case "Restart":
      return to["wake"] === "running"
        ? "Kin restarts and picks the turn up again"
        : "Kin restarts mid-turn";
    default:
      return action;
  }
};
