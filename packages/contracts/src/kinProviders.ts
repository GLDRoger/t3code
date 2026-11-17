/**
 * The built-ins a Kin agent may use in its owner's own chats, each step checked by Kin. A chat
 * others read gets none of them on any provider.
 */
export const KIN_CAPABILITIES = [
  "shell",
  "backgroundShell",
  "readFiles",
  "editFiles",
  "webSearch",
  "webFetch",
  "viewImage",
  "subAgents",
] as const;
export type KinCapability = (typeof KIN_CAPABILITIES)[number];

/** What the agent's page and its own instructions say it can't do there. */
export const KIN_CAPABILITY_WORDS: Readonly<Record<KinCapability, string>> = {
  shell: "run commands",
  backgroundShell: "keep a command running in the background",
  readFiles: "read files",
  editFiles: "edit files",
  webSearch: "search the web",
  webFetch: "open a web page directly",
  viewImage: "look at an image file",
  subAgents: "start sub-agents",
};

/** What clients and the host both know of a provider an agent may run on (`lead/turn/providers`). */
export interface KinProviderFacts {
  /** T3's driver kind. */
  readonly driver: string;
  readonly label: string;
  /** The model option that holds Kin's one effort label. */
  readonly effortOption: string;
  /** Offered only with the host's switch for agents on other providers on. */
  readonly behindSwitch: boolean;
  /** Offered only on a dev server: a scripted provider that runs no model. */
  readonly devOnly: boolean;
  /** Built-ins it lacks; the agent is told, and so is the owner on the agent's page. */
  readonly lacks: ReadonlyArray<KinCapability>;
}

export const KIN_PROVIDER_FACTS: ReadonlyArray<KinProviderFacts> = [
  {
    driver: "claudeAgent",
    label: "Claude",
    effortOption: "effort",
    behindSwitch: false,
    devOnly: false,
    lacks: [],
  },
  {
    driver: "codex",
    label: "OpenAI",
    effortOption: "reasoningEffort",
    behindSwitch: true,
    devOnly: false,
    // Under full access Codex sends stdin to an open session unasked (`stdin_approval.rs`).
    lacks: ["backgroundShell", "webFetch"],
  },
  {
    driver: "acpRegistry",
    label: "ACP agent (dev)",
    effortOption: "effort",
    behindSwitch: false,
    devOnly: true,
    lacks: [...KIN_CAPABILITIES],
  },
];

export const kinProviderFacts = (driver: string | undefined) =>
  KIN_PROVIDER_FACTS.find((facts) => facts.driver === driver);

/** Whether an agent may run on this driver, by the host's switch and whether it's a dev server. */
export const kinAgentDriverAllowed = (
  driver: string | undefined,
  otherProviders: boolean,
  devServer = false,
) => {
  const facts = kinProviderFacts(driver);
  return (
    facts !== undefined && (!facts.behindSwitch || otherProviders) && (!facts.devOnly || devServer)
  );
};
