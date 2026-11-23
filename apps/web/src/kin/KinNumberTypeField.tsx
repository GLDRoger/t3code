import { KIN_NUMBERS } from "@t3tools/client-runtime/kin/kinNumbers";
import type { KinListOutcome } from "@t3tools/client-runtime/kin/kinLists";
import { useId, useState } from "react";

import { Input } from "../components/ui/input";

/**
 * Today's value typed on a number's row: Enter saves it. A refusal says what went wrong under the
 * field and keeps what was typed; once saved the row shows the value instead.
 */
export function KinNumberTypeField(props: {
  readonly name: string;
  readonly label?: string;
  readonly placeholder?: string;
  readonly onSave: (typed: string) => Promise<KinListOutcome<unknown>>;
  readonly onSaved?: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const problemId = useId();
  const send = async () => {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    const outcome = await props.onSave(typed);
    setSaving(false);
    if (outcome.ok) {
      setTyped("");
      props.onSaved?.();
    } else setProblem(outcome.problem);
  };
  return (
    <div className="flex w-full flex-col gap-1 sm:w-48">
      <Input
        size="sm"
        value={typed}
        inputMode="decimal"
        enterKeyHint="done"
        autoComplete="off"
        placeholder={saving ? KIN_NUMBERS.saving : (props.placeholder ?? KIN_NUMBERS.type)}
        aria-label={props.label ?? `${KIN_NUMBERS.today}: ${props.name}`}
        aria-invalid={problem !== null || undefined}
        aria-describedby={problem === null ? undefined : problemId}
        aria-busy={saving || undefined}
        readOnly={saving}
        onChange={(event) => {
          setTyped(event.target.value);
          if (problem !== null) setProblem(null);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void send();
        }}
      />
      {problem === null ? null : (
        <p id={problemId} role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
    </div>
  );
}
