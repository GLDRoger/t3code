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

/**
 * What Kin can't promise on a provider: its own config (skills, settings) still loads, tools the
 * agent runs without asking can't be taken from a chat others read, or its shell inherits the
 * server's environment. Such a provider stays dev-only.
 */
export type KinProviderLimit = "ownConfigLoads" | "ownToolsStay" | "hostEnvironment";

/** "a, b or c": what a provider lacks, in the words the agent and its owner both read. */
export const kinCantDo = (lacks: ReadonlyArray<KinCapability>) => {
  const words = lacks.map((capability) => KIN_CAPABILITY_WORDS[capability]);
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
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
  readonly limits: ReadonlyArray<KinProviderLimit>;
}

export const KIN_PROVIDER_FACTS: ReadonlyArray<KinProviderFacts> = [
  {
    driver: "claudeAgent",
    label: "Claude",
    effortOption: "effort",
    behindSwitch: false,
    devOnly: false,
    lacks: [],
    limits: [],
  },
  {
    driver: "codex",
    label: "OpenAI",
    effortOption: "reasoningEffort",
    behindSwitch: true,
    devOnly: false,
    // Under full access Codex sends stdin to an open session unasked (`stdin_approval.rs`).
    lacks: ["backgroundShell", "webFetch"],
    limits: [],
  },
  {
    driver: "acpRegistry",
    label: "ACP agent (dev)",
    effortOption: "effort",
    behindSwitch: false,
    devOnly: true,
    // Kin serves an ACP agent no built-ins; what it brings of its own, Kin sees only when it asks.
    lacks: [...KIN_CAPABILITIES],
    limits: ["ownConfigLoads", "ownToolsStay", "hostEnvironment"],
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
