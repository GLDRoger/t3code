type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Vars = Record<string, Value>;

/** A per-day function, printed by TLC as `(0 :> a @@ 1 :> b)`. */
const ofDay = (value: Value | undefined, day: number): Value | undefined =>
  typeof value === "object" && !Array.isArray(value) ? value[String(day)] : undefined;
const DAY = 12;

export const title = "Your loose morning check-in, and a fact it should mention";

export const guide =
  "Your check-in is set “around 9:00”: it may come any time from 8:55 to 9:20, the same minute however often Kin works it out. Each box is where today's check-in stands; each arrow is something that happens: time passes, Kin's host sleeps or wakes, its clock is set forward or back, you move the check-in to 9:10, and a fact about a member's overdue task is held (“I've got it”) or clears. The model covers two days, one outage, one clock change and one move. Red boxes are where a rule below breaks.";

/** The chart is drawn on one day without clock changes; the rules are checked on the full bound. */
export const chartConstants = { Days: "1", MaxJumps: "0" };

export const rules: Record<string, string> = {
  OncePerDay: "A day's check-in comes at most once, across restarts and clock changes.",
  NeverBeforeWindow: "A check-in never comes before its window opens.",
  InsideWindow: "The minute Kin picks for a check-in is inside its window, not after it closes.",
  StaysMoved: "A check-in you moved stays where you put it.",
  FiresWhenUp: "If Kin is running at any time in the window, that day's check-in happens.",
  FactNeverAbsent:
    "A fact that is open, even one someone has in hand, is in that day's check-in, never silently left out.",
  HandleKeepsTask: "Holding a fact (“I've got it”) never hides the member's task from them.",
};

export const variants = [
  { name: "no-dedupe", breaks: "OncePerDay", what: "the check-in's per-day key is dropped" },
  {
    name: "fire-early",
    breaks: "NeverBeforeWindow",
    what: "the slot runs five minutes before its window opens",
  },
  {
    name: "follow-moved",
    breaks: "StaysMoved",
    what: "following your time zone re-keys check-ins you moved",
  },
  { name: "handle-hides-task", breaks: "HandleKeepsTask", what: "holding a fact closes the task" },
];

export const state = (vars: Vars) => {
  const clock = Number(vars["clock"]);
  const day = Math.floor(clock / DAY);
  const name = day === 0 ? "" : "Next day: ";
  const woke = Number(ofDay(vars["woke"], day));
  if (Number.isNaN(woke)) return "The day is over";
  if (woke > 1) return `${name}Check-in came twice`;
  if (woke === 1) return `${name}Check-in came`;
  if (ofDay(vars["skipped"], day) === true) return `${name}Skipped as “nothing new”, fact in hand`;
  if (Number(ofDay(vars["queued"], day)) !== 0) return `${name}Check-in on its way`;
  if (ofDay(vars["ran"], day) === true) return `${name}Nothing to check in about`;
  const into = clock % DAY;
  const slot = Number(vars["slot"]);
  if (into > slot + 5) return `${name}Window passed, no check-in`;
  if (into >= slot) return `${name}Window open${vars["up"] === false ? ", Kin is down" : ""}`;
  return `${name}Before the window`;
};

export const step = (action: string, from: Vars, to: Vars) => {
  switch (action) {
    case "Tick":
      return from["up"] === false ? "Five minutes pass, the host asleep" : "Five minutes pass";
    case "ClockJumps":
      return Number(to["clock"]) > Number(from["clock"])
        ? "The host's clock jumps 15 minutes forward"
        : "The host's clock jumps 15 minutes back";
    case "GoesDown":
      return "Kin's host sleeps";
    case "ComesUp":
      return "Kin wakes";
    case "SlotRuns": {
      if (Number(from["clock"]) - Number(from["nextRun"]) > 2)
        return "Kin finds it more than 10 minutes late and skips it";
      const fact = from["fact"];
      return fact === "open"
        ? "The slot comes up, the fact open"
        : fact === "held"
          ? "The slot comes up, the fact in hand"
          : "The slot comes up, nothing open";
    }
    case "AgentWakes":
      return "The agent checks in";
    case "OwnerMoves":
      return "You move it to around 9:10";
    case "SeedFollows":
      return "Kin follows your time zone";
    case "FactHeld":
      return "Someone says “I've got it” about the fact";
    case "FactClears":
      return "The fact clears";
    default:
      return action;
  }
};
