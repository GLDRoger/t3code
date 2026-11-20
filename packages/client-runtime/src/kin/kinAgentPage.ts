// @effect-diagnostics globalDate:off - Pure view helpers format change dates for React render, outside an Effect runtime.
import { kinNow } from "./kinNow.ts";
import { kinWorkAllDay } from "./kinWork.ts";
import {
  type KinAgentPage,
  type KinPersonAccess,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
  formatKinWhen,
  KIN_PROVIDER_FACTS,
  KIN_TAKEN_DEFAULT_FIELD,
} from "@t3tools/contracts";

import { isReasoningSelect } from "../modelTraits.ts";

/**
 * What a viewer may do on an agent's page. The owner and co-owners see and change all of it; a
 * project lead or a member gets the short card (name, what it does, how to reach it) and nothing
 * the owner keeps private: its model, character, access or spend. The host refuses the rest anyway.
 */
export interface KinAgentPageCan {
  /** `unknown` until the host has said who the viewer is: neither card, and no refusal. */
  readonly card: "full" | "short" | "unknown";
  readonly edit: boolean;
  readonly model: boolean;
  readonly character: boolean;
  readonly access: boolean;
  readonly pause: boolean;
  readonly remove: boolean;
}

const SHORT: KinAgentPageCan = {
  card: "short",
  edit: false,
  model: false,
  character: false,
  access: false,
  pause: false,
  remove: false,
};

export function kinAgentPageCan(viewer: {
  /** `undefined` until the host has said; null when it named no kind. */
  readonly access: KinPersonAccess | null | undefined;
  /** Leads a project. Leading one gives no say over agents. */
  readonly leadsAProject?: boolean;
}): KinAgentPageCan {
  if (viewer.access === undefined) return { ...SHORT, card: "unknown" };
  if (viewer.access !== "owner" && viewer.access !== "co_owner") return SHORT;
  return {
    card: "full",
    edit: true,
    model: true,
    character: true,
    access: true,
    pause: true,
    remove: true,
  };
}

export const KIN_AGENT_PAGE = {
  loadFailed: "Couldn't load this agent",
  ownerLevelOnly: "Only the owner and co-owners see this agent's details.",
  notTeamAgent:
    "Not the team agent. Everyone in the company can message it, except anyone you restrict.",
  modelFailed: "Couldn't change the model.",
  characterFailed: "Couldn't save the character.",
  nothingWaiting: "Nothing is waiting on it.",
  defaultsUnchosen: "Until you choose, they start on your first agent's.",
  model: "Model",
  modelDetail: "Applies from its next reply.",
  effort: "Effort",
  defaults: "New agents run on",
  defaultsDetail: "Agents you add from now on start on these. You can change each one on its page.",
  character: "Character",
  characterRule:
    "A character changes how it sounds and what it cares about. It never changes what it may do or see.",
  characterEmpty: "Kin gives it a character on its next start.",
  editCharacter: "Edit",
  characterHistory: "History",
  rewrite: "Ask it to rewrite itself",
  checkIns: "Check-ins",
  checkInsNone: "It speaks when spoken to: no check-ins.",
  reach: "What it can reach",
  reachNone: "No outside accounts are connected.",
  reachDetail: "Every agent uses the same connections, only in your own chats with it.",
  playbooks: "Playbooks it follows",
  playbooksNone: "No playbooks yet.",
  activity: "In hand",
  pause: "Pause",
  resume: "Resume",
  pausedLine: (name: string) =>
    `${name} is paused. Messages to it wait until you resume it; nothing else wakes it.`,
  pauseDetail: "Pausing lets a reply under way finish. Messages wait until you resume it.",
  teamAgent: "Team agent",
  teamAgentDetail:
    "Everyone on the team can message it, except anyone you restrict, and it answers in the company chat.",
  writeForMe: "Write one for me",
  writeForMeDetail: "After you create it, the Chief of staff drafts its character with you.",
  characterField: "Character",
  characterPlaceholder:
    "Who it is: an archetype, what it loves, what it pushes back on, how it writes.",
} as const;

/** Kin's advice on reasoning effort, the same on every client and for any provider. */
export const KIN_AGENT_EFFORT = {
  recommended: "Recommended",
  advice:
    "Medium or High is recommended. Low is too shallow; anything above High tends to over-think, whichever model you pick.",
} as const;
const RECOMMENDED_EFFORTS: ReadonlyArray<string> = ["medium", "high"];

type AdvisableModel = Pick<ServerProviderModel, "slug" | "capabilities">;
const reasoningOf = (models: ReadonlyArray<AdvisableModel>, slug: string) =>
  models
    .find((model) => model.slug === slug)
    ?.capabilities?.optionDescriptors?.find(isReasoningSelect);

/** A reasoning control with Medium and High first and marked; the other levels follow as listed. */
export function kinAdviseEffort(descriptor: ProviderOptionDescriptor): ProviderOptionDescriptor {
  if (!isReasoningSelect(descriptor)) return descriptor;
  const recommended = RECOMMENDED_EFFORTS.flatMap((id) => {
    const option = descriptor.options.find((one) => one.id === id);
    return option === undefined ? [] : [{ ...option, description: KIN_AGENT_EFFORT.recommended }];
  });
  if (recommended.length === 0) return descriptor;
  const rest = descriptor.options.filter((one) => !RECOMMENDED_EFFORTS.includes(one.id));
  return { ...descriptor, options: [...recommended, ...rest] };
}

/** The provider's models as Kin's pickers offer them: each one's effort levels advised. */
export function kinAdvisedModels<M extends AdvisableModel>(models: ReadonlyArray<M>): Array<M> {
  return models.map((model) => {
    const descriptors = model.capabilities?.optionDescriptors;
    if (descriptors === undefined || model.capabilities == null) return model;
    return {
      ...model,
      capabilities: { ...model.capabilities, optionDescriptors: descriptors.map(kinAdviseEffort) },
    };
  });
}

/** Whether the model offers an effort control, so the advice has something to sit under. */
export const kinHasEffort = (selection: ModelSelection, models: ReadonlyArray<AdvisableModel>) =>
  reasoningOf(models, selection.model) !== undefined;

/** Whether a chosen effort is below Medium or above High. An unset effort is not flagged. */
export function kinEffortOffAdvice(
  selection: ModelSelection,
  models: ReadonlyArray<AdvisableModel>,
): boolean {
  const reasoning = reasoningOf(models, selection.model);
  if (reasoning === undefined) return false;
  const chosen = selection.options?.find((option) => option.id === reasoning.id)?.value;
  return (
    typeof chosen === "string" &&
    reasoning.options.some((option) => option.id === chosen) &&
    !RECOMMENDED_EFFORTS.includes(chosen)
  );
}

/** A freshly picked model at Medium effort, when it offers Medium and no effort was chosen. */
export function kinWithMediumEffort(
  selection: ModelSelection,
  models: ReadonlyArray<AdvisableModel>,
): ModelSelection {
  const reasoning = reasoningOf(models, selection.model);
  if (
    reasoning === undefined ||
    !reasoning.options.some((option) => option.id === "medium") ||
    selection.options?.some((option) => option.id === reasoning.id) === true
  )
    return selection;
  return {
    ...selection,
    options: [...(selection.options ?? []), { id: reasoning.id, value: "medium" }],
  };
}

const KIN_EFFORT_OPTIONS = new Set(KIN_PROVIDER_FACTS.map((facts) => facts.effortOption));

/** "Sonnet 4.6, high effort" from a model's name and the effort it was saved with. */
export function kinAgentModelLine(
  name: string,
  selection: { readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }> },
): string {
  const effort = selection.options?.find((option) => KIN_EFFORT_OPTIONS.has(option.id))?.value;
  return typeof effort === "string" && effort !== "default" ? `${name}, ${effort} effort` : name;
}

/** This month's use in a line: replies and a rounded token count, or that it hasn't run. */
export function kinAgentUsageLine(used: KinAgentPage["usedThisMonth"]): string {
  if (used.turns === 0) return "No replies yet this month.";
  const replies = `${used.turns} ${used.turns === 1 ? "reply" : "replies"} this month`;
  if (used.tokens === 0) return `${replies}.`;
  const tokens =
    used.tokens >= 1_000_000
      ? `${(used.tokens / 1_000_000).toFixed(1)}M`
      : used.tokens >= 1_000
        ? `${Math.round(used.tokens / 1_000)}k`
        : String(used.tokens);
  return `${replies}, about ${tokens} tokens.`;
}

/** When its unprompted messages wait: the company's quiet hours. */
export function kinAgentQuietLine(hours: KinAgentPage["quietHours"]): string {
  return `Quiet hours ${hours.from}–${hours.to}: anything it would send unprompted waits until they end.`;
}

/** The line put in its chat when the owner asks it to rewrite its own character. */
export function kinAgentRewriteStarter(name: string): string {
  return `${name}, rewrite your character with me. Offer a sharper one in a few lines (an archetype, what you love, what you push back on, how you write) and save it when I agree.`;
}

/** The line put in the Chief of staff's chat to draft a new agent's character. */
export function kinAgentWriteCharacterStarter(name: string, area: string): string {
  return `Write a character for ${name}, our new ${area} agent: an archetype, its biases and favourites, and how it talks. Show me a draft and save it to its character doc when I agree.`;
}

/** "Changed lately": its last record changes, each opening its record, each with Undo where Kin can. */
export const KIN_AGENT_CHANGES = {
  title: "Changed lately",
  detail: "Its last 20 changes to tasks, clients, money and docs. Undo puts back what it replaced.",
  none: "It hasn't changed anything yet.",
  undo: "Undo",
  undoing: "Undoing…",
  undone: "Put back.",
  linkUndone: "Link removed.",
  sinceDetail:
    "Changed again after this, so Kin won't put it back over that. Open it to change it.",
  linkedSinceDetail:
    "It has links now, so Kin won't take it back on its own. Open it to change it.",
  linkGone: "Already removed.",
  manualDetail: "Kin can't put this one back on its own, such as an amount or a doc's text.",
  manualAddDetail: "Kin can't take this one back on its own. Open it to change it.",
  unseenEnd: "an entry you can't see",
  failed: "Couldn't undo that.",
} as const;

const FIELD_WORDS: Readonly<Record<string, string>> = {
  owner: "holder",
  waitingOn: "waiting on",
  due: "due",
  dueAllDay: "all day",
  date: "date",
  state: "status",
  notes: "notes",
  title: "title",
  party: "client",
  project: "project",
  category: "category",
  amount: "amount",
  repeat: "repeats",
  sensitive: "private",
  confirmed: "kept",
  repo: "repo",
  side: "side",
};
const HIDDEN_FIELDS = new Set(["reason", "handedBack", "untold", KIN_TAKEN_DEFAULT_FIELD]);
const VALUE_MAX = 40;
/** Links whose shown end is words, such as "PR #12"; other kinds name an id. */
const SHOWN_LINKS = new Set(["url", "pull_request"]);

type Change = NonNullable<KinAgentPage["changed"]>[number];

/** One change in words: "Added W-4 Draft the brochure", "W-2 Brochure: holder Zoya → Arjun". */
export function kinAgentChangeLine(
  change: Change,
  names: ReadonlyMap<string, string>,
  now: Date = kinNow(),
  /** The company's, whose calendar a due or date is on; this device's until it is read. */
  zone: string | null = null,
): string {
  const record = `${change.key} ${change.title}`;
  if (change.kind === "created") return `Added ${record}`;
  const short = (shown: string) =>
    shown.length > VALUE_MAX ? `${shown.slice(0, VALUE_MAX - 1)}…` : shown;
  if (change.kind === "linked") {
    const [made] = change.fields;
    const other =
      change.linkedTo === null
        ? KIN_AGENT_CHANGES.unseenEnd
        : change.linkedTo !== undefined
          ? short(`${change.linkedTo.key} ${change.linkedTo.title}`)
          : made?.to != null && SHOWN_LINKS.has(made.field)
            ? short(made.to)
            : undefined;
    return other === undefined ? `Linked ${record}` : `Linked ${record} to ${other}`;
  }
  const value = (field: string, shown: string | null) => {
    if (shown === null || shown === "") return "none";
    const principal = /^(person|agent):(.+)$/.exec(shown);
    if (principal !== null && (field === "owner" || field === "waitingOn"))
      return names.get(principal[2]!) ?? (principal[1] === "agent" ? "an agent" : "someone");
    if (field === "party" || field === "project") {
      const title = change.named?.find((one) => one.key === shown)?.title;
      return title === undefined ? shown : short(`${shown} ${title}`);
    }
    const day = field === "due" || field === "date" ? kinWorkAllDay(shown, true, { zone }) : null;
    if (day !== null)
      return formatKinWhen(
        Date.parse(`${day}T12:00:00Z`),
        Number(day.slice(0, 4)) === now.getFullYear() ? "date" : "dateYear",
        { zone: "UTC" },
      );
    return short(shown);
  };
  const parts = change.fields
    .filter((one) => !HIDDEN_FIELDS.has(one.field))
    .map(
      (one) =>
        `${FIELD_WORDS[one.field] ?? one.field} ${value(one.field, one.from)} → ${value(one.field, one.to)}`,
    );
  return parts.length === 0 ? `Changed ${record}` : `${record}: ${parts.join("; ")}`;
}

/**
 * What the row offers: Undo and what it says once done, or the sentence saying why not.
 * `undoneHere`: this person's Undo of it just went through, so it keeps saying that.
 */
export const kinAgentChangeOffer = (change: Change, undoneHere = false) =>
  change.undo
    ? ({
        kind: "undo",
        done: change.kind === "linked" ? KIN_AGENT_CHANGES.linkUndone : KIN_AGENT_CHANGES.undone,
      } as const)
    : change.undone === true
      ? ({
          kind: "undone",
          text:
            change.kind !== "linked"
              ? KIN_AGENT_CHANGES.undone
              : undoneHere
                ? KIN_AGENT_CHANGES.linkUndone
                : KIN_AGENT_CHANGES.linkGone,
        } as const)
      : change.kind === "linked"
        ? ({ kind: "none" } as const)
        : change.since
          ? ({
              kind: "since",
              text:
                change.linkedSince === true
                  ? KIN_AGENT_CHANGES.linkedSinceDetail
                  : KIN_AGENT_CHANGES.sinceDetail,
            } as const)
          : ({
              kind: "manual",
              text:
                change.kind === "created"
                  ? KIN_AGENT_CHANGES.manualAddDetail
                  : KIN_AGENT_CHANGES.manualDetail,
            } as const);
