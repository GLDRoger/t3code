/** What the owner reads at a dead end in a Kin-only app, where there are no environments to manage. */
export const KIN_ONLY_NO_HOST = {
  title: "Kin isn't on that computer",
  detail:
    "This phone is connected to a computer that doesn't run Kin. Connect it to the one that does.",
  actionLabel: "Connect to your Kin",
} as const;

export const KIN_ONLY_UNPAIRED = {
  title: "This phone isn't connected anymore",
  detail: "Connect it to your Kin again to open this chat.",
  actionLabel: "Connect to your Kin",
} as const;

export const KIN_ONLY_UNAUTHORIZED = {
  title: "This phone can't read your chats",
  detail: "Connect it again from the computer that runs your Kin.",
} as const;
