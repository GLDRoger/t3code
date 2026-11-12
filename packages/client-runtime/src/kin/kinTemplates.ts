// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import type { KinRecipe, KinRecordDetail } from "@t3tools/contracts";

import { formatKinTime } from "./kinScreenState.ts";
import { kinWorkActorName, type KinWorkNames } from "./kinWork.ts";

export const KIN_TEMPLATES = {
  title: "Templates",
  detail:
    "How Kin makes your documents. Agents write them; you can preview, undo or ask for changes.",
  empty: "No templates yet. Ask an agent to set one up.",
  preview: "Preview",
  previewing: "Making a preview…",
  previewFailed: "That template made no file to preview.",
  undo: "Undo last change",
  undoTitle: "Undo this template's last change?",
  undoDetail: "It goes back to how it was before. You can undo the undo.",
  undone: "Undone.",
  removed: "Undone. That change made this template, so it's gone until you undo again.",
  private: "Private",
  privateDetail: "What it makes is marked private, so only you and your own chats see it.",
  clearPrivate: "Mark as not private",
  clearTitle: "Mark this template as not private?",
  clearDetail: "Documents it makes from now on are no longer marked private because of it.",
  cleared: "No longer marked private.",
  setPrivate: "Mark as private",
  setTitle: "Mark this template as private?",
  setDetail:
    "Documents it makes from now on are private: only you see them, and agents only in your own chats.",
  set: "Marked private.",
  isDefault: (list: string) => `Used for ${list.toLowerCase()}`,
  pickFor: (list: string) => `Use for ${list.toLowerCase()}`,
  defaultSet: (list: string) => `Kin now makes ${list.toLowerCase()} with this template.`,
  askChange: "Change how invoices look",
  askChangeDraft: "I'd like to change how our invoices look: ",
  noPreviewEntry: "Preview needs an entry. Open one from its list and use Make invoice there.",
};

const LIST_NAMES: Readonly<Record<string, string>> = {
  invoices: "Invoices",
  receipts: "Receipts",
  expenses: "Expenses",
};

export interface KinTemplateView {
  readonly name: string;
  readonly title: string;
  readonly description: string | null;
  readonly changed: string;
  readonly labelled: boolean;
  /** The one its list's documents are made with unless another is picked. */
  readonly isDefault: boolean;
  readonly commit: string;
  /** A template that needs an entry can only be previewed from one. */
  readonly forEntry: boolean;
  readonly canUndo: boolean;
}

export interface KinTemplateGroup {
  readonly list: string | null;
  readonly title: string;
  readonly templates: ReadonlyArray<KinTemplateView>;
}

const changedBy = (recipe: KinRecipe, names: KinWorkNames) =>
  recipe.changedBy._tag === "starter"
    ? "Kin's starter"
    : recipe.changedBy._tag === "agent"
      ? kinWorkActorName({ _tag: "agent", agentId: recipe.changedBy.agentId }, names)
      : kinWorkActorName({ _tag: "person", personId: recipe.changedBy.personId }, names);

/** The template a list's documents are made with: its default, else the first there is. */
export const kinDefaultTemplate = <T extends Pick<KinRecipe, "default">>(
  templates: ReadonlyArray<T>,
): T | null => templates.find((one) => one.default === true) ?? templates[0] ?? null;

/** Templates by what they make, invoices first, each with who changed it last and when. */
export function kinTemplateGroups(
  recipes: ReadonlyArray<KinRecipe>,
  names: KinWorkNames,
  now: Date,
): ReadonlyArray<KinTemplateGroup> {
  const groups = new Map<string | null, KinTemplateView[]>();
  for (const recipe of recipes) {
    const by = changedBy(recipe, names);
    const view: KinTemplateView = {
      name: recipe.name,
      title: recipe.title.trim() === "" ? recipe.name : recipe.title,
      description: recipe.description.trim() === "" ? null : recipe.description.trim(),
      changed:
        recipe.changedAt === null
          ? by
          : `Changed by ${by}, ${formatKinTime(new Date(recipe.changedAt), now)}`,
      labelled: recipe.labelled === true,
      isDefault: recipe.default === true,
      commit: recipe.commit,
      forEntry: recipe.list !== null,
      canUndo: recipe.changedBy._tag !== "starter",
    };
    groups.set(recipe.list, [...(groups.get(recipe.list) ?? []), view]);
  }
  const order = (list: string | null) =>
    list === "invoices" ? 0 : list === "receipts" ? 1 : list === null ? 3 : 2;
  return [...groups.entries()]
    .sort(([a], [b]) => order(a) - order(b) || String(a).localeCompare(String(b)))
    .map(([list, templates]) => ({
      list,
      title: list === null ? "Other documents" : (LIST_NAMES[list] ?? list),
      templates,
    }));
}

export const KIN_NOTES = {
  earlier: (count: number) => (count === 1 ? "1 earlier version" : `${count} earlier versions`),
  first: "First version",
  restore: "Restore",
  restoreTitle: "Restore this version of the notes?",
  restoreDetail:
    "It replaces the notes now, as a new change. The current notes stay in the history.",
};

export interface KinNotesVersion {
  readonly key: string;
  readonly text: string;
  /** "Finance, 7 Nov"; null for the first version, which came before the kept history. */
  readonly by: string | null;
}

/**
 * Earlier versions of an entry's notes, newest first, from its history. The current notes are
 * not among them; an empty version is skipped as there is nothing to bring back.
 */
export function kinNotesVersions(
  item: Pick<KinRecordDetail, "changes" | "notes">,
  names: KinWorkNames,
  now: Date,
): ReadonlyArray<KinNotesVersion> {
  const edits = item.changes.flatMap((change) =>
    change.fields
      .filter((field) => field.field === "notes")
      .map((field) => ({ change, from: field.from, to: field.to })),
  );
  const versions: KinNotesVersion[] = edits.slice(1).map(({ change, to }) => ({
    key: String(change.seq),
    text: to ?? "",
    by: `${kinWorkActorName(change.by, names)}, ${formatKinTime(new Date(change.at), now)}`,
  }));
  const first = edits.at(-1);
  if (first !== undefined) versions.push({ key: "first", text: first.from ?? "", by: null });
  const current = item.notes.trim();
  return versions.filter((version) => {
    const text = version.text.trim();
    return text !== "" && text !== current;
  });
}

/** The doc menu's way to raise or lower its private label; none while its client's label holds it. */
export function kinDocLabelAction(doc: {
  readonly sensitive: boolean;
  readonly sensitiveInherited?: true | undefined;
}) {
  if (doc.sensitiveInherited === true) return null;
  return doc.sensitive
    ? {
        sensitive: false,
        label: "Mark as not private",
        title: "Mark this doc as not private?",
        detail:
          "Your team and its agents will be able to read it. Agents can't do this; only you can.",
      }
    : {
        sensitive: true,
        label: "Mark as private",
        title: "Mark this doc as private?",
        detail: "Only you will be able to read it, and agents only in your own chats.",
      };
}

/** Whether the notes were ever changed, so cleared notes still offer their earlier versions. */
export const kinHasNotesHistory = (item: Pick<KinRecordDetail, "changes">) =>
  item.changes.some((change) => change.fields.some((field) => field.field === "notes"));
