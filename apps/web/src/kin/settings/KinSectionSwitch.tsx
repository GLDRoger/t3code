import {
  KIN_SECTION_SWITCHES,
  kinSectionOn,
  type KinSectionId,
} from "@t3tools/client-runtime/kin/kinShell";
import type { EnvironmentId, KinShell } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { Switch } from "../../components/ui/switch";
import { useKinSectionCanSet, useKinSectionSet, useKinShell } from "../useKinShell";
import type { KinWorkTarget } from "../useKinWork";
import { KinSettingsLoading, KinSettingsRow, KinSettingsSection } from "./KinSettingsLayout";

/**
 * A section's switch, for the owner level only: what turning it off does, that nothing is deleted,
 * and that older phone apps keep the place. Nothing shows to anyone else, or on an older host.
 */
export function KinSectionSwitch(props: KinWorkTarget & { readonly id: KinSectionId }) {
  const words = KIN_SECTION_SWITCHES[props.id];
  const shell = useKinShell(props.environmentId);
  const may = useKinSectionCanSet(props.environmentId);
  const set = useKinSectionSet(props);
  // The save's answer, until `kin.access.me` reads it back.
  const [saved, setSaved] = useState<KinShell | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!may || words === undefined || shell === undefined) return null;
  const held = shell === null || (saved !== null && saved.rev > shell.rev) ? saved : shell;
  const on = kinSectionOn(held, props.id);
  return (
    <div className="flex flex-col gap-2">
      <KinSettingsSection problem={problem}>
        {held === null ? (
          <KinSettingsLoading rows={1} />
        ) : (
          <KinSettingsRow
            title={words.title}
            wrap
            detail={`${words.detail} ${words.kept}`}
            control={
              <Switch
                aria-label={words.title}
                aria-busy={busy}
                checked={on}
                disabled={busy}
                onCheckedChange={async (next) => {
                  setBusy(true);
                  setProblem(null);
                  const outcome = await set(held, props.id, next);
                  setBusy(false);
                  if (outcome.ok) setSaved(outcome.value);
                  else setProblem(outcome.problem);
                }}
              />
            }
          />
        )}
      </KinSettingsSection>
      <p className="text-pretty px-1 text-xs text-muted-foreground">{words.olderPhones}</p>
    </div>
  );
}

/** A section's other settings while it is off: still there to change, and said to be unused. */
export function KinSectionInactive(props: {
  readonly environmentId: EnvironmentId;
  readonly id: KinSectionId;
  readonly children: ReactNode;
}) {
  const on = kinSectionOn(useKinShell(props.environmentId), props.id);
  const words = KIN_SECTION_SWITCHES[props.id];
  if (on || words === undefined) return props.children;
  return (
    <>
      <p role="note" className="-mb-4 text-pretty px-1 text-sm text-muted-foreground">
        {words.inactive}
      </p>
      <div data-kin-section-off="" className="contents [&>section]:opacity-64">
        {props.children}
      </div>
    </>
  );
}
