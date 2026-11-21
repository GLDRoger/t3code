/** What a Kin client calls the thing it runs on, in sentences about that device. */
export type KinDevice = "browser" | "phone";

/** Sentences both clients say about the device they run on and the server it is paired with. */
export const KIN_DEVICE_COPY = {
  leaveTeam: "Leave this team",
  leaveTeamTitle: "Leave this team?",
  pairAgain: "Pair it again with the server that runs Kin.",
  pairToOpen: "Pair it with the server this chat is on to open it.",
  cantReadChats: (device: KinDevice) => `This ${device} can't read Kin chats`,
  cantAct: (device: KinDevice, act: "answer" | "confirm") =>
    `This ${device} can't ${act} here. Pair it again with the server that runs Kin.`,
  unknownEnvironment: (device: KinDevice) =>
    `That thread is on an environment this ${device} doesn't know.`,
  /** The phone keeps chats on the device for offline reading; leaving removes them. */
  leave: (device: KinDevice) =>
    `You'll be signed out on this ${device}${device === "phone" ? " and its chats will be removed from it" : ""}. To come back, ask your team for a new join link: it brings back your chats and tasks.`,
} as const;
