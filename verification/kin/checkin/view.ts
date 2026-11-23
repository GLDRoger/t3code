type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Vars = Record<string, Value>;

/** A per-day function, printed by TLC as `(0 :> a @@ 1 :> b)`. */
const ofDay = (value: Value | undefined, day: number): Value | undefined =>
  typeof value === "object" && !Array.isArray(value) ? value[String(day)] : undefined;
const DAY = 12;

export const title =
  "Your loose morning check-in, a fact it tells once, and a post that waits until its reader is free";

export const guide =
  "Your check-in is set “around 9:00”: it may come any time from 8:55 to 9:20, the same minute however often Kin works it out. Each box is where today's check-in stands; each arrow is something that happens: time passes, Kin's host sleeps or wakes, its clock is set forward or back, you move the check-in to 9:10, and a fact about a member's overdue task is held (“I've got it”) or clears. A fact is told once, and again only when it changed. An omitted fact can be offered at the next check-in. Something nobody asked for that comes in your quiet hours, a message passed on to you included, waits for them to end; one for a member waits, on her own clock, through her quiet hours and outside her working hours. The model covers two days, one outage, one clock change and one move. Red boxes are where a rule below breaks.";

/** The chart is drawn on one day without clock changes; the rules are checked on the full bound. */
export const chartConstants = { Days: "1", MaxJumps: "0" };

export const rules: Record<string, string> = {
  OncePerDay: "A day's check-in comes at most once, across restarts and clock changes.",
  NeverBeforeWindow: "A check-in never comes before its window opens.",
  InsideWindow:
    "The minute Kin picks for a check-in is inside its window; one Kin only noticed after the window closed comes at once, never later still.",
  StaysMoved: "A check-in you moved stays where you put it.",
  FiresWhenUp:
    "If Kin is running at any time in the window, that day's check-in happens, even when the host woke too late for T3's scheduler.",
  FactNeverAbsent:
    "A fact you haven't been told as it stands now, even one someone has in hand, is offered to that day's check-in.",
  HandleKeepsTask: "Holding a fact (“I've got it”) never hides the member's task from them.",
  OmissionsReleased: "A fact the check-in left out can be offered again.",
  ToldOnce: "A fact that hasn't changed is told at most once.",
  HeldDeliveredOnce: "A post held through your quiet hours reaches you exactly once.",
  HeldNeverLost: "A held post is never lost, even when Kin restarts before your quiet hours end.",
  QuietIsQuiet:
    "Nothing anyone didn't ask for lands in their quiet hours, on their own clock: yours, or a member's half a day ahead.",
  OffHoursWait:
    "Nothing a member didn't ask for lands outside her working hours while she holds messages then.",
};

export const variants = [
  { name: "no-dedupe", breaks: "OncePerDay", what: "the check-in's per-day key is dropped" },
  {
    name: "fire-early",
    breaks: "NeverBeforeWindow",
    what: "the slot runs five minutes before its window opens and picks its minute from that start",
  },
  {
    name: "follow-moved",
    breaks: "StaysMoved",
    what: "following your time zone re-keys check-ins you moved",
  },
  { name: "handle-hides-task", breaks: "HandleKeepsTask", what: "holding a fact closes the task" },
  {
    name: "no-catch-up",
    breaks: "FiresWhenUp",
    what: "Kin no longer catches up a check-in T3's scheduler skipped as late (the code before this change)",
  },
  {
    name: "late-offset",
    breaks: "InsideWindow",
    what: "a late start picks its minute from the start, not the window (the code before this change)",
  },
  {
    name: "keep-omission",
    breaks: "OmissionsReleased",
    what: "an omitted fact still counts as told",
  },
  { name: "tell-again", breaks: "ToldOnce", what: "a told fact counts as new at every check-in" },
  {
    name: "held-in-memory",
    breaks: "HeldNeverLost",
    what: "a held post is kept in memory, so a restart loses it",
  },
  {
    name: "deliver-twice",
    breaks: "HeldDeliveredOnce",
    what: "delivering a held post doesn't mark it delivered",
  },
  { name: "post-in-quiet", breaks: "QuietIsQuiet", what: "quiet hours only silence the sound" },
  {
    name: "deliver-late-night",
    breaks: "QuietIsQuiet",
    what: "a host that slept all day posts the held line in the next night",
  },
  {
    name: "company-clock",
    breaks: "QuietIsQuiet",
    what: "a member's hours are read on the company's clock, not hers",
  },
  {
    name: "quiet-only",
    breaks: "OffHoursWait",
    what: "only quiet hours hold a line; working hours don't (the code before this change)",
  },
  {
    name: "held-left-out",
    breaks: "FactNeverAbsent",
    what: "a fact someone holds doesn't count, so the check-in says “nothing new” (the code before this change)",
  },
];

export const state = (vars: Vars) => {
  const base = checkInState(vars);
  if (vars["held"] !== true) return base;
  return vars["to"] === "member"
    ? `${base}; a post waits for the member to start`
    : `${base}; a post waits for morning`;
};

const checkInState = (vars: Vars) => {
  const clock = Number(vars["clock"]);
  const day = Math.floor(clock / DAY);
  const name = day === 0 ? "" : "Next day: ";
  const woke = Number(ofDay(vars["woke"], day));
  if (Number.isNaN(woke)) return "The day is over";
  if (woke > 1) return `${name}Check-in came twice`;
  if (woke === 1) return `${name}Check-in came`;
  if (ofDay(vars["skipped"], day) === true) return `${name}Skipped as “nothing new”, fact untold`;
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
    case "CatchUp":
      return "Kin notices today's check-in never ran and sends it now";
    case "AgentWakes": {
      const day = [0, 1].find((d) => ofDay(from["woke"], d) !== ofDay(to["woke"], d));
      const result = day === undefined ? undefined : ofDay(to["told"], day);
      return Array.isArray(result) && result[1] === true
        ? "The agent checks in and leaves the fact out"
        : "The agent checks in with the fact";
    }
    case "OwnerMoves":
      return "You move it to around 9:10";
    case "SeedFollows":
      return "Kin follows your time zone";
    case "FactHeld":
      return "Someone says “I've got it” about the fact";
    case "FactClears":
      return "The fact clears";
    case "QuietPost":
      return to["to"] === "member"
        ? "Something nobody asked for comes for a member outside her hours"
        : "Something nobody asked for comes in your quiet hours";
    case "Deliver":
      return from["to"] === "member"
        ? "Her working hours start and the held post lands"
        : "Your quiet hours end and the held post lands";
    default:
      return action;
  }
};
