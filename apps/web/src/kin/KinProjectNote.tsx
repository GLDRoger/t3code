import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_PROJECT_NOTE, KIN_TASK_RECORD } from "@t3tools/client-runtime/kin/kinTaskRecord";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { KIN_RECORD_COMMENT_MAX, type KinProjectNote, type KinRecordKey } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { PencilIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { randomUUID } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { KinWorkSection } from "./KinWorkParts";
import type { KinWorkTarget } from "./useKinWork";

/**
 * A project's one "Note for every task": words its tasks show at the top of their Activity. The
 * owner level writes, rewrites or clears it here; everyone else who opens the project reads it.
 */
export function KinProjectNoteSection(
  props: KinWorkTarget & {
    readonly projectKey: KinRecordKey;
    readonly note: KinProjectNote | null;
    readonly canEdit: boolean;
    readonly onChanged: () => void;
  },
) {
  const save = useAtomCommand(kinClient.workProjectNote, { reportFailure: false });
  const { canEdit } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One id per wording until the host takes it, so a retry after a dropped answer writes once.
  const request = useRef<{ readonly body: string; readonly id: string } | null>(null);
  const fieldId = useId();
  if (props.note === null && !canEdit) return null;
  const tooLong = draft !== null && draft.trim().length > KIN_RECORD_COMMENT_MAX;

  const write = async (body: string) => {
    const words = body.trim();
    const id = request.current?.body === words ? request.current.id : randomUUID();
    request.current = { body: words, id };
    setBusy(true);
    setProblem(null);
    const outcome = await save({
      environmentId: props.environmentId,
      input: { orgId: props.orgId, key: props.projectKey, clientRequestId: id, body: words },
    });
    setBusy(false);
    if (AsyncResult.isFailure(outcome))
      return setProblem(
        kinFailureText(squashAtomCommandFailure(outcome), KIN_PROJECT_NOTE.notSaved),
      );
    request.current = null;
    setDraft(null);
    props.onChanged();
  };

  return (
    <KinWorkSection
      title={KIN_PROJECT_NOTE.title}
      action={
        !canEdit || draft !== null ? null : (
          <Button
            size="xs"
            variant="ghost"
            aria-label={`${KIN_PROJECT_NOTE.edit} ${KIN_PROJECT_NOTE.title}`}
            onClick={() => setDraft(props.note?.body ?? "")}
          >
            <PencilIcon />
            {KIN_PROJECT_NOTE.edit}
          </Button>
        )
      }
    >
      {draft === null ? (
        <>
          <p
            className={
              props.note === null
                ? "text-sm text-muted-foreground"
                : "whitespace-pre-wrap wrap-break-word text-sm text-foreground"
            }
          >
            {props.note?.body ?? KIN_PROJECT_NOTE.empty}
          </p>
          <p className="text-xs text-muted-foreground">{KIN_PROJECT_NOTE.hint}</p>
        </>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!tooLong) void write(draft);
          }}
        >
          <label htmlFor={fieldId} className="sr-only">
            {KIN_PROJECT_NOTE.title}
          </label>
          <Textarea
            id={fieldId}
            autoFocus
            value={draft}
            placeholder={KIN_PROJECT_NOTE.placeholder}
            onChange={(event) => setDraft(event.target.value)}
          />
          {tooLong || problem !== null ? (
            <p role="alert" className="text-xs text-destructive-foreground">
              {tooLong ? KIN_TASK_RECORD.noteTooLong(KIN_RECORD_COMMENT_MAX) : problem}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" size="xs" disabled={busy || tooLong} aria-busy={busy}>
              {KIN_PROJECT_NOTE.save}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setProblem(null);
              }}
            >
              {KIN_PROJECT_NOTE.cancel}
            </Button>
            {props.note === null ? null : (
              <Button
                type="button"
                size="xs"
                variant="ghost-destructive"
                disabled={busy}
                onClick={() => void write("")}
              >
                {KIN_PROJECT_NOTE.clear}
              </Button>
            )}
          </div>
        </form>
      )}
    </KinWorkSection>
  );
}
