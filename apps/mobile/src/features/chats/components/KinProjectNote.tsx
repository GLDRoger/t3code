import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_PROJECT_NOTE, KIN_TASK_RECORD } from "@t3tools/client-runtime/kin/kinTaskRecord";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  KIN_RECORD_COMMENT_MAX,
  type EnvironmentId,
  type KinOrgId,
  type KinProjectNote,
  type KinRecordKey,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ListSection } from "../../../components/ui/ListSection";
import { uuidv4 } from "../../../lib/uuid";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";

/**
 * A project's one "Note for every task": its tasks show it at the top of their Activity. The
 * owner level writes, rewrites or clears it here; everyone else who opens the project reads it.
 */
export function KinProjectNoteSection(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly projectKey: KinRecordKey;
  readonly note: KinProjectNote | null;
  readonly canEdit: boolean;
  readonly onChanged: () => void;
}) {
  const save = useAtomCommand(kinClient.workProjectNote, { reportFailure: false });
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One id per wording until the host takes it, so a retry after a dropped answer writes once.
  const request = useRef<{ readonly body: string; readonly id: string } | null>(null);
  if (props.note === null && !props.canEdit) return null;
  const tooLong = draft !== null && draft.trim().length > KIN_RECORD_COMMENT_MAX;

  const write = async (body: string) => {
    const words = body.trim();
    const id = request.current?.body === words ? request.current.id : uuidv4();
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
    <ListSection
      title={KIN_PROJECT_NOTE.title}
      footer={KIN_PROJECT_NOTE.hint}
      {...(!props.canEdit || draft !== null
        ? {}
        : {
            trailing: (
              <Button
                tone="text"
                size="compact"
                label={KIN_PROJECT_NOTE.edit}
                accessibilityLabel={`${KIN_PROJECT_NOTE.edit} ${KIN_PROJECT_NOTE.title}`}
                onPress={() => setDraft(props.note?.body ?? "")}
              />
            ),
          })}
    >
      <View className="gap-2.5 px-4 py-3.5">
        {draft === null ? (
          <Text
            textRole="body"
            selectable
            className={props.note === null ? "text-foreground-muted" : "text-foreground"}
          >
            {props.note?.body ?? KIN_PROJECT_NOTE.empty}
          </Text>
        ) : (
          <>
            <TextInput
              accessibilityLabel={KIN_PROJECT_NOTE.title}
              value={draft}
              editable={!busy}
              multiline
              autoFocus
              onChangeText={setDraft}
              placeholder={KIN_PROJECT_NOTE.placeholder}
              placeholderTextColorClassName="accent-placeholder"
              className="min-h-20 font-sans text-base text-foreground"
            />
            {tooLong || problem !== null ? (
              <Text
                textRole="caption"
                accessibilityLiveRegion="polite"
                className="text-danger-foreground"
              >
                {tooLong ? KIN_TASK_RECORD.noteTooLong(KIN_RECORD_COMMENT_MAX) : problem}
              </Text>
            ) : null}
            <View className="flex-row flex-wrap gap-2">
              <Button
                tone="primary"
                size="compact"
                label={KIN_PROJECT_NOTE.save}
                loading={busy}
                disabled={busy || tooLong}
                onPress={() => void write(draft)}
              />
              <Button
                tone="text"
                size="compact"
                label={KIN_PROJECT_NOTE.cancel}
                disabled={busy}
                onPress={() => {
                  setDraft(null);
                  setProblem(null);
                }}
              />
              {props.note === null ? null : (
                <Button
                  tone="danger"
                  size="compact"
                  label={KIN_PROJECT_NOTE.clear}
                  disabled={busy}
                  onPress={() => void write("")}
                />
              )}
            </View>
          </>
        )}
      </View>
    </ListSection>
  );
}
