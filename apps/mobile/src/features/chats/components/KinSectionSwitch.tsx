import {
  KIN_SECTION_SWITCHES,
  kinSectionOn,
  type KinSectionId,
} from "@t3tools/client-runtime/kin/kinShell";
import type { KinShell } from "@t3tools/contracts";
import { useState } from "react";

import { AppText as Text } from "../../../components/ui/AppText";
import { ListSection } from "../../../components/ui/ListSection";
import { ListToggleRow } from "../../../components/ui/ListToggleRow";
import { Notice } from "../../../components/ui/Notice";
import { useKinSectionCanSet, useKinSectionSet, useKinShell } from "../state/useKinShell";
import type { KinWorkTarget } from "../state/useKinWork";
import { KinWorkLoading } from "./KinWorkPieces";

/**
 * A section's switch, for the owner level only: what turning it off does, that nothing is deleted,
 * and that older phone apps keep the place. While off, a line says the settings below aren't used.
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
  if (held === null) return <KinWorkLoading label={words.title} />;
  const on = kinSectionOn(held, props.id);
  return (
    <>
      {problem === null ? null : (
        <Notice message={problem} tone="danger" onDismiss={() => setProblem(null)} />
      )}
      <ListSection footer={`${words.kept} ${words.olderPhones}`}>
        <ListToggleRow
          label={words.title}
          description={words.detail}
          disabled={busy}
          value={on}
          onValueChange={async (next) => {
            setBusy(true);
            setProblem(null);
            const outcome = await set(held, props.id, next);
            setBusy(false);
            if (outcome.ok) setSaved(outcome.value);
            else setProblem(outcome.problem);
          }}
        />
      </ListSection>
      {on ? null : (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {words.inactive}
        </Text>
      )}
    </>
  );
}
