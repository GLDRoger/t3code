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
  type KinSectionChange,
  type KinSwitchableSection,
} from "@t3tools/client-runtime/kin/kinShell";
import type { KinShell } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ListSection } from "../../../components/ui/ListSection";
import { ListToggleRow } from "../../../components/ui/ListToggleRow";
import { Notice } from "../../../components/ui/Notice";
import { useKinSectionCanSet, useKinSectionSet, useKinShell } from "../state/useKinShell";
import type { KinWorkTarget } from "../state/useKinWork";
import { KinWorkLoading, KinWorkTextField } from "./KinWorkPieces";

/**
 * The shell as this screen holds it: the host's, or a save's answer until `kin.access.me` reads it
 * back, so a switch never flicks back. Null while the host hasn't said; undefined from an older host.
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
      if (outcome.changed) setSaved(null);
      return outcome.problem;
    },
  };
}

type Held = ReturnType<typeof useHeldShell>;

/** One section's switch, with its failure said above it, in place, until the next change. */
function KinSectionRow(props: {
  readonly id: KinSwitchableSection;
  readonly held: Held;
  readonly shell: KinShell;
  readonly titled: "name" | "sentence";
  readonly footer?: string;
}) {
  const words = KIN_SECTION_SWITCHES[props.id];
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const heldOff = kinSectionHeldOffLine(props.shell, props.id);
  const detail = kinSectionNamed(props.shell, heldOff ?? words.detail);
  return (
    <>
      {problem === null ? null : (
        <Notice message={problem} tone="danger" onDismiss={() => setProblem(null)} />
      )}
      <ListSection {...(props.footer === undefined ? {} : { footer: props.footer })}>
        <ListToggleRow
          label={props.titled === "name" ? kinSectionName(props.shell, props.id) : words.title}
          description={detail}
          // Held off by another section: the line says which; nothing to send from here.
          disabled={busy || heldOff !== null}
          value={kinSectionOn(props.shell, props.id)}
          onValueChange={async (next) => {
            setBusy(true);
            setProblem(null);
            setProblem(await props.held.change(props.shell, { id: props.id, on: next }));
            setBusy(false);
          }}
        />
      </ListSection>
    </>
  );
}

/**
 * A section's switch alone on its own page (Settings › Deals), for the owner level only: what
 * turning it off does, that nothing is deleted, and that older phone apps keep the place. While off,
 * a line says the settings below aren't used.
 */
export function KinSectionSwitch(props: KinWorkTarget & { readonly id: KinSwitchableSection }) {
  const words = KIN_SECTION_SWITCHES[props.id];
  const may = useKinSectionCanSet(props.environmentId);
  const held = useHeldShell(props);
  if (!may || held.held === undefined) return null;
  if (held.held === null) return <KinWorkLoading label={words.title} />;
  const shell = held.held;
  return (
    <>
      <KinSectionRow
        id={props.id}
        held={held}
        shell={shell}
        titled="sentence"
        footer={`${words.kept} ${words.olderPhones}`}
      />
      {kinSectionOn(shell, props.id) ? null : (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {kinSectionHeldOffLine(shell, props.id) ?? words.inactive}
        </Text>
      )}
    </>
  );
}

/** Clients' own name: "Call it…", and the way back to Kin's. */
function KinSectionRename(props: { readonly held: Held; readonly shell: KinShell }) {
  const words = KIN_SECTIONS_PAGE.rename;
  const renamed = kinSectionRenamed(props.shell);
  const [name, setName] = useState(renamed ? kinSectionName(props.shell, "clients") : "");
  const [noun, setNoun] = useState(renamed ? kinSectionNoun(props.shell, "clients") : "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const notReady = kinSectionNameProblem(name, noun);
  const save = async (plural: string, one: string) => {
    setBusy(true);
    setProblem(null);
    const failed = await props.held.change(props.shell, { id: "clients", name: plural, noun: one });
    setBusy(false);
    setProblem(failed);
  };
  return (
    <ListSection title={words.title} footer={words.detail}>
      <View className="gap-3 p-3">
        {problem === null ? null : <Notice message={problem} tone="danger" />}
        <KinWorkTextField
          label={words.name}
          value={name}
          placeholder={words.namePlaceholder}
          maxLength={40}
          disabled={busy}
          onChangeText={setName}
        />
        <KinWorkTextField
          label={words.noun}
          value={noun}
          placeholder={words.nounPlaceholder}
          maxLength={40}
          disabled={busy}
          onChangeText={setNoun}
        />
        {notReady === null || name.trim() === "" ? null : (
          <Text textRole="footnote" className="text-foreground-muted">
            {notReady}
          </Text>
        )}
        <View className="flex-row flex-wrap gap-2">
          <Button
            label={words.save}
            size="compact"
            loading={busy}
            disabled={busy || name.trim() === "" || notReady !== null}
            onPress={() => save(name, noun)}
          />
          {renamed ? (
            <Button
              label={words.backToKins}
              size="compact"
              tone="outline"
              disabled={busy}
              onPress={() => save("", "")}
            />
          ) : null}
        </View>
      </View>
    </ListSection>
  );
}

/** Settings › Sections on the phone: each section the company can switch, and Clients' name. */
export function KinSectionsSettings(props: KinWorkTarget) {
  const may = useKinSectionCanSet(props.environmentId);
  const held = useHeldShell(props);
  // The host sets sections for the owner level only; anyone else reaching the address sees none.
  if (!may) return null;
  if (held.held === undefined)
    return (
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        This computer's Kin is older than sections. Update it to choose them.
      </Text>
    );
  if (held.held === null) return <KinWorkLoading label={KIN_SECTIONS_PAGE.title} />;
  const shell = held.held;
  return (
    <>
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {KIN_SECTIONS_PAGE.intro}
      </Text>
      {KIN_SWITCHABLE_SECTIONS.map((id) => (
        <KinSectionRow key={id} id={id} held={held} shell={shell} titled="name" />
      ))}
      {/* A fresh form per saved name, so "Use Kin's name" empties the fields. */}
      <KinSectionRename
        key={`${kinSectionName(shell, "clients")}/${kinSectionNoun(shell, "clients")}`}
        held={held}
        shell={shell}
      />
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {KIN_SECTIONS_PAGE.olderPhones}
      </Text>
    </>
  );
}
