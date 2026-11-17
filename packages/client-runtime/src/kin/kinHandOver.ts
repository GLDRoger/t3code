import type { KinWorkPrincipal } from "@t3tools/contracts";

/** "Give all open tasks to…": the count, one ask, then Undo right after. */
export const KIN_HAND_OVER = {
  action: "Give all open tasks to…",
  mineAction: "Give all my open tasks to…",
  title: (count: number, name: string | null) =>
    `Give ${count === 1 ? "1 open task" : `${count} open tasks`} ${name === null ? "you hold" : `${name} holds`}?`,
  pick: "To",
  pickPlaceholder: "Choose who takes them",
  hint: "Each moves as if you gave it on its own and shows in its history. Whoever takes them is told once.",
  none: (name: string | null) =>
    name === null ? "You hold no open tasks." : `${name} holds no open tasks.`,
  confirm: (count: number) => (count === 1 ? "Give it" : `Give all ${count}`),
  giving: "Giving…",
  done: (count: number, to: string) =>
    `${count === 1 ? "1 task" : `${count} tasks`} given to ${to}.`,
  kept: (count: number) =>
    count === 0 ? "" : ` ${count === 1 ? "1 stayed" : `${count} stayed`}: you can't give those.`,
  undo: "Undo",
  undone: "Given back.",
  failed: "Couldn't give them.",
  removeOffer: (count: number, name: string) =>
    `${name} still holds ${count === 1 ? "1 open task" : `${count} open tasks`}. Give them to someone first, or they stay in ${name}'s name under Needs attention.`,
} as const;

/** Who may take them: anyone but whoever holds them now. */
export const kinHandOverChoices = <T extends { readonly principal: KinWorkPrincipal }>(
  choices: ReadonlyArray<T>,
  from: KinWorkPrincipal,
): ReadonlyArray<T> =>
  choices.filter(
    (choice) =>
      choice.principal._tag !== from._tag ||
      (choice.principal._tag === "person"
        ? from._tag === "person" && choice.principal.personId !== from.personId
        : from._tag === "agent" && choice.principal.agentId !== from.agentId),
  );
