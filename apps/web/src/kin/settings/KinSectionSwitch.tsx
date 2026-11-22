import {
  KIN_SECTION_SWITCHES,
  KIN_SECTIONS_PAGE,
  KIN_SWITCHABLE_SECTIONS,
  kinSectionHeldOffLine,
  kinSectionName,
  kinSectionNamed,
  kinSectionNameProblem,
  kinSectionNoun,
  kinSectionOn,
  kinSectionRenamed,
  kinSectionSwitchOn,
  type KinSectionChange,
  type KinSwitchableSection,
} from "@t3tools/client-runtime/kin/kinShell";
import type { EnvironmentId, KinShell } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { useKinSectionCanSet, useKinSectionSet, useKinShell } from "../useKinShell";
import type { KinWorkTarget } from "../useKinWork";
import { KinSettingsField, KinSettingsFormDialog } from "./KinSettingsControls";
import { KinSettingsLoading, KinSettingsRow, KinSettingsSection } from "./KinSettingsLayout";

/**
 * The shell as this page holds it: the host's, or a save's answer until `kin.access.me` reads it
 * back, so a switch never flicks back to the tapped-away state. Null while the host hasn't said;
 * undefined from a host older than sections.
 */
function useHeldShell(target: KinWorkTarget) {
  const shell = useKinShell(target.environmentId);
  const set = useKinSectionSet(target);
  const [saved, setSaved] = useState<KinShell | null>(null);
  const held =
    shell === undefined
      ? undefined
      : shell === null || (saved !== null && saved.rev > shell.rev)
        ? saved
        : shell;
  return {
    held,
    /** Saves one change; the host's words on failure, null once saved. */
    change: async (from: KinShell, change: KinSectionChange): Promise<string | null> => {
      const outcome = await set(from, change);
      if (outcome.ok) {
        setSaved(outcome.value);
        return null;
      }
      // Changed elsewhere: the host's answer is read again, so drop ours.
      if (outcome.changed) setSaved(null);
      return outcome.problem;
    },
  };
}

type Held = ReturnType<typeof useHeldShell>;

/** One section's switch row in its own card, with its failure said under it, in place. */
function KinSectionRow(props: {
  readonly id: KinSwitchableSection;
  readonly held: Held;
  readonly shell: KinShell;
  /** The section's own name as the title (Sections), or its switch's sentence (its own page). */
  readonly titled: "name" | "sentence";
  readonly children?: ReactNode;
}) {
  const words = KIN_SECTION_SWITCHES[props.id];
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const title = props.titled === "name" ? kinSectionName(props.shell, props.id) : words.title;
  const heldOff = kinSectionHeldOffLine(props.shell, props.id);
  const on = kinSectionOn(props.shell, props.id);
  const detail = kinSectionNamed(
    props.shell,
    heldOff ??
      // Its own page says nothing is deleted; Sections says it once, above every row.
      (props.titled === "sentence" ? `${words.detail} ${words.kept}` : words.detail),
  );
  return (
    <KinSettingsSection problem={problem}>
      <KinSettingsRow
        title={title}
        wrap
        detail={detail}
        control={
          <Switch
            aria-label={title}
            aria-busy={busy}
            aria-description={heldOff ?? undefined}
            checked={on}
            // Held off by another section: the line says which; nothing to send from here.
            disabled={busy || heldOff !== null}
            onCheckedChange={async (next) => {
              setBusy(true);
              setProblem(null);
              setProblem(await props.held.change(props.shell, { id: props.id, on: next }));
              setBusy(false);
            }}
          />
        }
      />
      {props.children}
    </KinSettingsSection>
  );
}

/**
 * A section's switch alone, for the owner level only, on that section's own page (Settings ›
 * Deals): what turning it off does, that nothing is deleted, and that older phone apps keep the
 * place. Nothing shows to anyone else, or on an older host.
 */
export function KinSectionSwitch(props: KinWorkTarget & { readonly id: KinSwitchableSection }) {
  const may = useKinSectionCanSet(props.environmentId);
  const held = useHeldShell(props);
  if (!may || held.held === undefined) return null;
  return (
    <div className="flex flex-col gap-2">
      {held.held === null ? (
        <KinSettingsSection>
          <KinSettingsLoading rows={1} />
        </KinSettingsSection>
      ) : (
        <KinSectionRow id={props.id} held={held} shell={held.held} titled="sentence" />
      )}
      <p className="text-pretty px-1 text-xs text-muted-foreground">
        {KIN_SECTION_SWITCHES[props.id].olderPhones}
      </p>
    </div>
  );
}

/** Clients' own name: "Call it…", and the way back to Kin's. */
function KinSectionRenameRow(props: { readonly held: Held; readonly shell: KinShell }) {
  const words = KIN_SECTIONS_PAGE.rename;
  const renamed = kinSectionRenamed(props.shell);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (name: string, noun: string) => {
    setBusy(true);
    setProblem(null);
    const failed = await props.held.change(props.shell, { id: "clients", name, noun });
    setBusy(false);
    setProblem(failed);
    if (failed === null) setEditing(false);
  };
  return (
    <>
      <KinSettingsRow
        title={words.title}
        wrap
        detail={
          renamed
            ? `${kinSectionName(props.shell, "clients")}, one ${kinSectionNoun(props.shell, "clients")}`
            : words.detail
        }
        control={
          <>
            {renamed ? (
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => save("", "")}>
                {words.backToKins}
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setProblem(null);
                setEditing(true);
              }}
            >
              {renamed ? "Change" : "Rename"}
            </Button>
          </>
        }
      />
      {problem === null || editing ? null : (
        <p role="alert" className="px-4 pb-3 text-pretty text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
      {editing ? (
        <KinSectionRenameDialog
          shell={props.shell}
          busy={busy}
          problem={problem}
          onSave={save}
          onClose={() => {
            setEditing(false);
            setProblem(null);
          }}
        />
      ) : null}
    </>
  );
}

function KinSectionRenameDialog(props: {
  readonly shell: KinShell;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onSave: (name: string, noun: string) => void;
  readonly onClose: () => void;
}) {
  const words = KIN_SECTIONS_PAGE.rename;
  const renamed = kinSectionRenamed(props.shell);
  const [name, setName] = useState(renamed ? kinSectionName(props.shell, "clients") : "");
  const [noun, setNoun] = useState(renamed ? kinSectionNoun(props.shell, "clients") : "");
  const notReady = kinSectionNameProblem(name, noun);
  return (
    <KinSettingsFormDialog
      title={words.title}
      description={words.detail}
      submitLabel={words.save}
      busy={props.busy}
      notReady={name.trim() === "" ? "" : notReady}
      problem={props.problem}
      typed={name !== "" || noun !== ""}
      onSubmit={() => props.onSave(name, noun)}
      onClose={props.onClose}
    >
      <KinSettingsField label={words.name}>
        {({ control }) => (
          <Input
            id={control}
            value={name}
            maxLength={40}
            placeholder={words.namePlaceholder}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </KinSettingsField>
      <KinSettingsField label={words.noun}>
        {({ control }) => (
          <Input
            id={control}
            value={noun}
            maxLength={40}
            placeholder={words.nounPlaceholder}
            onChange={(event) => setNoun(event.target.value)}
          />
        )}
      </KinSettingsField>
    </KinSettingsFormDialog>
  );
}

/**
 * Settings › Sections: each section the company can switch, with Clients' own name. The owner
 * level only; Docs is always on, so it isn't listed.
 */
export function KinSectionsSettings(props: KinWorkTarget) {
  const may = useKinSectionCanSet(props.environmentId);
  const held = useHeldShell(props);
  // The host sets sections for the owner level only; anyone else reaching the address sees none.
  if (!may) return null;
  if (held.held === undefined)
    return (
      <p className="text-pretty px-1 text-sm text-muted-foreground">
        This computer's Kin is older than sections. Update it to choose them.
      </p>
    );
  const shell = held.held;
  return (
    <>
      {shell === null ? (
        <KinSettingsSection>
          <KinSettingsLoading rows={4} />
        </KinSettingsSection>
      ) : (
        KIN_SWITCHABLE_SECTIONS.map((id) => (
          <KinSectionRow key={id} id={id} held={held} shell={shell} titled="name">
            {id === "clients" ? <KinSectionRenameRow held={held} shell={shell} /> : null}
          </KinSectionRow>
        ))
      )}
      <p className="text-pretty px-1 text-xs text-muted-foreground">
        {KIN_SECTIONS_PAGE.olderPhones}
      </p>
    </>
  );
}

/** A section's other settings while it is off: still there to change, and said to be unused. */
export function KinSectionInactive(props: {
  readonly environmentId: EnvironmentId;
  readonly id: KinSwitchableSection;
  readonly children: ReactNode;
}) {
  const shell = useKinShell(props.environmentId);
  if (kinSectionOn(shell, props.id)) return props.children;
  return (
    <>
      <p role="note" className="-mb-4 text-pretty px-1 text-sm text-muted-foreground">
        {kinSectionSwitchOn(shell, props.id)
          ? kinSectionHeldOffLine(shell, props.id)
          : KIN_SECTION_SWITCHES[props.id].inactive}
      </p>
      <div data-kin-section-off="" className="contents [&>section]:opacity-64">
        {props.children}
      </div>
    </>
  );
}
