/** What the owner reads at a dead end in a Kin-only app, where there are no environments to manage. */
export const KIN_ONLY_NO_HOST = {
  title: "Kin isn't on that computer",
  detail:
    "This phone is connected to a computer that doesn't run Kin. Connect it to the one that does.",
  actionLabel: "Connect to your Kin",
} as const;

/** Computers are saved on this phone but none answers, as after signing out of the one that does. */
export const KIN_ONLY_UNREACHABLE = {
  title: "Can't reach your Kin",
  detail:
    "No computer this phone knows is answering. If you signed out, connect to your Kin again.",
  actionLabel: "Connect to your Kin",
} as const;

/** A teammate's phone with no answer from their team's Kin; after signing out, the way back in. */
export const KIN_TEAMMATE_UNREACHABLE = {
  title: "Can't reach your team's Kin",
  detail:
    "Your chats come back when it answers. If you signed out, ask your team for a new join link.",
  actionLabel: "Join with a new link",
} as const;

/** A teammate's phone connected to a computer that doesn't run Kin. */
export const KIN_TEAMMATE_NO_HOST = {
  title: "Kin isn't on that computer",
  detail: "Ask your team whether your Kin moved, and for a new join link if it did.",
} as const;

export const KIN_ONLY_UNPAIRED = {
  title: "This phone isn't connected to that Kin",
  detail: "Connect it to your Kin to open this chat.",
  actionLabel: "Connect to your Kin",
} as const;

export const KIN_ONLY_UNAUTHORIZED = {
  title: "This phone can't read your chats",
  detail: "Connect it again from the computer that runs your Kin.",
} as const;
