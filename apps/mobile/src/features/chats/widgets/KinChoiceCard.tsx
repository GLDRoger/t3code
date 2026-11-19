import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import { KIN_CARD_COPY } from "@t3tools/client-runtime/kin/kinCardPresentation";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinPersonId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Image as ExpoImage } from "expo-image";
import { memo, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { AppState, Pressable, TextInput, View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../lib/cn";
import { assetImageSource } from "../../../lib/assetImageSource";
import { useNowMinuteMs } from "../../../lib/clock";
import { uuidv4 } from "../../../lib/uuid";
import { useAssetUrl, useRefreshAssetUrl } from "../../../state/assets";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
import { useKinOpenWaitingFor } from "../state/useKinOpen";
import { kinChoiceDefaultLine } from "@t3tools/client-runtime/kin/kinWaitingAsk";
import { kinConnectionChange } from "@t3tools/client-runtime/kin/kinConnections";
import {
  kinAddressPieces,
  kinChoiceAccessibilityLabel,
  kinChoiceActInput,
  kinChoiceAnswered,
  kinChoiceFailureNotice,
  kinChoicePhase,
  kinChoiceUndoneLine,
  kinSendEditBound,
  kinSendEditControls,
  kinSendEditDiscardInput,
  kinSendEditedLine,
  kinSendEditHeld,
  kinSendEditHeldKey,
  kinSendEditHold,
  kinSendEditInput,
  kinSendEditKept,
  kinSendEditLeaveSaves,
  kinSendEditOffered,
  kinSendEditRefused,
  kinSendEditSaveInput,
  kinSendEditShown,
  kinSendEditStart,
  kinSendEditUnsaved,
  KIN_SEND_EDIT_COPY,
  type KinSendEditBusy,
  type KinChoiceCardView,
  type KinSendEditDraft,
  type KinSendEditAck,
  type KinSendEditing,
} from "@t3tools/client-runtime/kin/kinChoicePresentation";
import {
  createKinCardActions,
  visibleKinCardStatus,
  type KinCardStatus,
} from "@t3tools/client-runtime/kin/kinDeferralPresentation";

// A mid grey: a white logo and a black one both stand out on it, in light and dark themes.
const IMAGE_GROUND = "#8c8c8c";

/** A send card's labelled lines; `fromAction` sits at the end of its From line. */
function SendLines(props: {
  readonly lines: NonNullable<KinChoiceCardView["send"]>["lines"];
  readonly fromAction?: ReactNode;
}) {
  return (
    <View className="gap-0.5">
      {props.lines.map((line) => (
        <View key={line.label} className="flex-row items-center gap-2">
          <Text textRole="footnote" className="flex-1 text-foreground">
            <Text textRole="footnote" className="text-foreground-muted">
              {line.label}{" "}
            </Text>
            {kinAddressPieces(line.value).join("​")}
          </Text>
          {line.label === "From" ? props.fromAction : null}
        </View>
      ))}
    </View>
  );
}

/** The mail's words as they go, with the earlier message quoted below them. */
function SendMessage(props: { readonly body: string | null; readonly quoted: string | null }) {
  return (
    <View className="rounded-xl bg-subtle px-3 py-2">
      {props.body === null ? null : (
        <Text textRole="body" className="text-foreground" selectable>
          {props.body}
        </Text>
      )}
      {props.quoted === null ? null : (
        <Text
          textRole="footnote"
          className={cn("text-foreground-muted", props.body !== null && "mt-3")}
          selectable
        >
          {props.quoted}
        </Text>
      )}
    </View>
  );
}

/** Exactly what a send card sends: who, the subject, the whole body and each file. */
function SendDetail(props: {
  readonly send: NonNullable<KinChoiceCardView["send"]>;
  /** "Edited by you" while the words shown are a person's saved edit. */
  readonly edited: string | null;
  /** Set while the owner may still switch From. */
  readonly pickFrom: {
    readonly busy: boolean;
    readonly problem: string | null;
    readonly pick: (id: string) => void;
  } | null;
}) {
  const { send, pickFrom } = props;
  const [choosing, setChoosing] = useState(false);
  const accounts = [...new Set(send.fromChoices.map((one) => one.account))];
  return (
    <View className="gap-2">
      <Text textRole="footnote" className="text-foreground-muted">
        {send.heading}
      </Text>
      {send.thread === null ? null : (
        <View className="gap-0.5 rounded-xl border border-border px-3 py-2">
          <Text textRole="footnote" className="font-t3-medium text-foreground">
            {send.thread.subject}
          </Text>
          <Text textRole="caption" className="text-foreground-muted">
            Replying to {send.thread.replyingTo}
            {send.thread.date === null ? "" : `, ${send.thread.date}`}
          </Text>
          {send.thread.lines === "" ? null : (
            <Text textRole="footnote" className="text-foreground" numberOfLines={2}>
              {send.thread.lines}
            </Text>
          )}
        </View>
      )}
      <SendLines
        lines={send.lines}
        fromAction={
          pickFrom === null ? null : (
            <Button
              label={choosing ? "Done" : "Change"}
              accessibilityHint="Pick another address to send from"
              tone="text"
              size="compact"
              loading={pickFrom.busy}
              onPress={() => setChoosing(!choosing)}
            />
          )
        }
      />
      {pickFrom !== null && choosing ? (
        <View accessibilityRole="radiogroup" className="gap-1 rounded-xl bg-subtle p-2">
          {accounts.map((account) => (
            <View key={account} className="gap-0.5">
              {accounts.length > 1 ? (
                <Text textRole="caption" className="px-2 pt-1 text-foreground-muted">
                  {account}
                </Text>
              ) : null}
              {send.fromChoices
                .filter((one) => one.account === account)
                .map((one) => (
                  <Pressable
                    key={one.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: one.current, disabled: pickFrom.busy }}
                    disabled={pickFrom.busy}
                    className="min-h-11 justify-center rounded-lg px-2"
                    onPress={() => {
                      if (!one.current) pickFrom.pick(one.id);
                      setChoosing(false);
                    }}
                  >
                    <Text
                      textRole="footnote"
                      className={one.current ? "font-t3-bold text-foreground" : "text-foreground"}
                    >
                      {one.label}
                      {one.current ? (
                        <Text textRole="footnote" className="text-foreground-muted">
                          {" "}
                          · in use
                        </Text>
                      ) : null}
                    </Text>
                  </Pressable>
                ))}
            </View>
          ))}
        </View>
      ) : null}
      {pickFrom?.problem == null ? null : (
        <Text accessibilityRole="alert" textRole="footnote" className="text-danger-foreground">
          {pickFrom.problem}
        </Text>
      )}
      <SendMessage body={send.body} quoted={send.quoted} />
      {props.edited === null ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {props.edited}
        </Text>
      )}
      {send.attachments.map((file) => (
        <View key={file.name} className="gap-0.5">
          <Text textRole="footnote" className="font-t3-medium text-foreground">
            Attached: {file.name}
          </Text>
          {file.detail === "" ? null : (
            <Text textRole="caption" className="text-foreground-muted">
              {file.detail}
            </Text>
          )}
        </View>
      ))}
      {send.outcome === null ? null : (
        <Text
          accessibilityRole="text"
          textRole="footnote"
          className={cn(
            "font-t3-medium",
            send.outcome.tone === "error" ? "text-danger-foreground" : "text-foreground",
          )}
        >
          {send.outcome.text}
        </Text>
      )}
    </View>
  );
}

/**
 * A mail card's To, Cc, Subject and Body, editable in place; its files go as drawn. Sending sends
 * the mail as it stands here; the host checks every field and says what it refused.
 */
function SendEditor(props: {
  readonly send: NonNullable<KinChoiceCardView["send"]>;
  readonly draft: KinSendEditDraft;
  readonly busy: boolean;
  readonly problem: string | null;
  /** The card changed under the editor: who it goes from now is shown again beside Send. */
  readonly review: boolean;
  readonly controls: ReturnType<typeof kinSendEditControls>;
  readonly onChange: (draft: KinSendEditDraft) => void;
  readonly onSave: () => void;
  readonly onSend: () => void;
  readonly onDiscard: () => void;
}) {
  const { send, draft, busy, controls } = props;
  const line = (name: "to" | "cc" | "subject", label: string, address: boolean) => (
    <View className="gap-1 rounded-xl bg-subtle px-3 py-2">
      <Text textRole="caption" className="text-foreground-muted">
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={address ? KIN_SEND_EDIT_COPY.addresses : undefined}
        value={draft[name]}
        editable={!busy}
        autoCapitalize={address ? "none" : "sentences"}
        autoCorrect={!address}
        keyboardType={address ? "email-address" : "default"}
        onChangeText={(value) => props.onChange({ ...draft, [name]: value })}
        className="min-h-8 font-sans text-base text-foreground"
      />
    </View>
  );
  return (
    <View className="gap-2">
      <Text textRole="footnote" className="text-foreground-muted">
        {send.heading}
      </Text>
      {send.from.length === 0 ? null : <SendLines lines={send.from} />}
      {line("to", KIN_SEND_EDIT_COPY.to, true)}
      {line("cc", KIN_SEND_EDIT_COPY.cc, true)}
      <Text textRole="caption" className="text-foreground-muted">
        {KIN_SEND_EDIT_COPY.addresses}
      </Text>
      {line("subject", KIN_SEND_EDIT_COPY.subject, false)}
      <View className="gap-1 rounded-xl bg-subtle px-3 py-2">
        <Text textRole="caption" className="text-foreground-muted">
          {KIN_SEND_EDIT_COPY.body}
        </Text>
        <TextInput
          accessibilityLabel={KIN_SEND_EDIT_COPY.body}
          value={draft.body}
          editable={!busy}
          multiline
          textAlignVertical="top"
          onChangeText={(body) => props.onChange({ ...draft, body })}
          className="min-h-24 font-sans text-base text-foreground"
        />
      </View>
      {send.quoted === null ? null : (
        <View className="gap-0.5">
          <SendMessage body={null} quoted={send.quoted} />
          <Text textRole="caption" className="text-foreground-muted">
            {KIN_SEND_EDIT_COPY.quoted}
          </Text>
        </View>
      )}
      {send.attachments.length === 0 ? null : (
        <View className="gap-0.5">
          {send.attachments.map((file) => (
            <Text key={file.name} textRole="footnote" className="font-t3-medium text-foreground">
              Attached: {file.name}
            </Text>
          ))}
          <Text textRole="caption" className="text-foreground-muted">
            {KIN_SEND_EDIT_COPY.attachments}
          </Text>
        </View>
      )}
      {props.problem === null ? null : (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          textRole="footnote"
          className="font-t3-medium text-danger-foreground"
        >
          {props.problem}
        </Text>
      )}
      {props.review && props.problem !== null && send.from.length > 0 ? (
        <SendLines lines={send.from} />
      ) : null}
      {controls.notice === null ? null : (
        <Text
          accessibilityLiveRegion="polite"
          textRole="footnote"
          className="text-foreground-muted"
        >
          {controls.notice}
        </Text>
      )}
      <View className="gap-2 pt-1">
        <Button
          label={controls.save.label}
          tone="outline"
          size="compact"
          fullWidth
          loading={controls.save.label === KIN_SEND_EDIT_COPY.saving}
          disabled={controls.save.disabled}
          onPress={props.onSave}
        />
        <Button
          label={controls.send.label}
          tone="primary"
          size="compact"
          fullWidth
          loading={controls.send.label === KIN_SEND_EDIT_COPY.sending}
          disabled={controls.send.disabled}
          onPress={props.onSend}
        />
        <Button
          label={controls.discard.label}
          tone="outline"
          size="compact"
          fullWidth
          loading={controls.discard.label === KIN_SEND_EDIT_COPY.discarding}
          disabled={controls.discard.disabled}
          onPress={props.onDiscard}
        />
      </View>
    </View>
  );
}

/** The card's picture, such as a logo to confirm, at a bounded size. */
function ChoiceImage(props: {
  readonly environmentId: EnvironmentId;
  readonly image: NonNullable<KinChoiceCardView["image"]>;
}) {
  const { image } = props;
  const resource = {
    _tag: "attachment" as const,
    attachmentId: image.attachmentId,
    fileName: `image.${image.mimeType.split("/")[1]?.replace("svg+xml", "svg") ?? "png"}`,
    mimeType: image.mimeType,
  };
  const uri = useAssetUrl(props.environmentId, resource);
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  const retried = useRef(false);
  const [failed, setFailed] = useState(false);
  return (
    <View
      className="h-28 items-center justify-center overflow-hidden rounded-xl border border-border p-3"
      style={{ backgroundColor: IMAGE_GROUND }}
    >
      {failed ? (
        <Text textRole="footnote" className="text-center text-white">
          {KIN_CARD_COPY.pictureFailed}
        </Text>
      ) : uri === null ? (
        <AppActivityIndicator />
      ) : (
        <ExpoImage
          source={assetImageSource(props.environmentId, resource, uri)}
          contentFit="contain"
          accessibilityLabel={KIN_CARD_COPY.choicePicture}
          style={{ width: "100%", height: "100%" }}
          onError={() => {
            if (retried.current) return setFailed(true);
            retried.current = true;
            void refresh();
          }}
        />
      )}
    </View>
  );
}

/** A lead's question with 2-4 answers. The owner's tap is their reply; it never approves anything. */
export const KinChoiceCard = memo(function KinChoiceCard(props: {
  readonly choice: KinChoiceCardView;
  readonly environmentId: EnvironmentId;
  readonly viewerPersonId: KinPersonId | null;
}) {
  const { choice, environmentId } = props;
  // The shared minute tick: enough to retire an expired card, never a repaint loop.
  const nowMs = useNowMinuteMs();
  const canAct = useAtomValue(kinClient.widgetAction.permissionAtom(environmentId));
  const post = useAtomCommand(kinClient.widgetAction, { reportFailure: false });
  const actions = useRef<ReturnType<typeof createKinCardActions<KinChoiceCardView, string>>>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchProblem, setSwitchProblem] = useState<string | null>(null);
  const setSendFrom = useAtomCommand(kinClient.connectionSetSendFrom, { reportFailure: false });
  const canEdit = useAtomValue(kinClient.connectionSendEdited.permissionAtom(environmentId));
  const sendEdited = useAtomCommand(kinClient.connectionSendEdited, { reportFailure: false });
  const saveEdited = useAtomCommand(kinClient.connectionSaveEdited, { reportFailure: false });
  const heldKey = kinSendEditHeldKey(environmentId, props.viewerPersonId, choice.widgetId);
  const [editing, setEditing] = useState<KinSendEditing | null>(() => kinSendEditHeld(heldKey));
  const [editBusy, setEditBusy] = useState<KinSendEditBusy>(null);
  // Kept with the editor closed: Edit before the card's update binds to what the host took.
  const [ack, setAck] = useState<KinSendEditAck | null>(null);
  const [lastStatus, setLastStatus] = useState<
    (KinCardStatus & { readonly optionId: string }) | null
  >(null);
  const status = visibleKinCardStatus(lastStatus, choice.revision);
  const phase = kinChoicePhase(choice, nowMs);
  // Until the answered card arrives, the tapped option already reads as chosen.
  const sentOption =
    status?.holding === true
      ? choice.options.find((option) => option.id === lastStatus?.optionId)
      : undefined;

  const press = async (optionId: string) => {
    if (pending !== null) return;
    if (actions.current === null)
      actions.current = createKinCardActions<KinChoiceCardView, string>({
        newId: uuidv4,
        toInput: kinChoiceActInput,
        failureNotice: kinChoiceFailureNotice,
        post: async (input) => {
          const result = await post({ environmentId, input });
          return AsyncResult.isFailure(result)
            ? { ok: false, cause: squashAtomCommandFailure(result) }
            : { ok: true };
        },
      });
    const revision = choice.revision;
    const outcome = await actions.current(choice, optionId, () => {
      setPending(optionId);
      setLastStatus(null);
    });
    if (outcome.status === "ignored") return;
    setPending(null);
    setLastStatus(
      outcome.status === "failed"
        ? { revision, optionId, notice: outcome.notice, holding: false }
        : { revision, optionId, notice: null, holding: true },
    );
  };

  const pickFrom = async (choiceId: string) => {
    if (switching || pending !== null) return;
    setSwitching(true);
    setSwitchProblem(null);
    const failed = await kinConnectionChange(
      setSendFrom({
        environmentId,
        input: {
          orgId: choice.orgId,
          widgetId: choice.widgetId,
          revision: choice.revision,
          choice: choiceId,
        },
      }),
      "change who it's from",
    );
    setSwitching(false);
    setSwitchProblem(failed);
  };

  const answered = kinChoiceAnswered(choice, props.viewerPersonId, sentOption?.label ?? null);
  const editable =
    answered === null && pending === null && kinSendEditOffered(choice, phase, canAct && canEdit);
  const shownEdit = kinSendEditShown(editing, editable) ? editing : null;
  const editBound = shownEdit === null ? null : kinSendEditBound(shownEdit, choice);
  const waiting = useKinOpenWaitingFor({ environmentId, orgId: choice.orgId });
  const takes =
    answered === null && phase === "open"
      ? kinChoiceDefaultLine(choice.widgetId, waiting, nowMs)
      : null;
  const undone = kinChoiceUndoneLine(choice, props.viewerPersonId, new Date(nowMs));

  /** The editor after the host answered: words it refused stay on this device until let go. */
  const settle = (next: KinSendEditing | null, kept: KinSendEditing | null = next) => {
    kinSendEditHold(heldKey, kept);
    setEditing(next);
  };
  const sendEdit = async () => {
    if (shownEdit === null || editBusy !== null || editBound?.ready !== true) return;
    setEditBusy("sending");
    const result = await sendEdited({
      environmentId,
      input: kinSendEditInput(choice, shownEdit, uuidv4()),
    });
    setEditBusy(null);
    settle(
      AsyncResult.isFailure(result)
        ? kinSendEditRefused(shownEdit, choice, squashAtomCommandFailure(result))
        : null,
    );
  };
  /** Save closes the editor; a save on leaving keeps it open over the saved card. */
  const saveEdit = async (stay = false) => {
    if (shownEdit === null || editBusy !== null || editBound?.ready !== true) return;
    if (!kinSendEditUnsaved(shownEdit)) return settle(null);
    setEditBusy("saving");
    const result = await saveEdited({
      environmentId,
      input: kinSendEditSaveInput(choice, shownEdit),
    });
    setEditBusy(null);
    if (AsyncResult.isFailure(result))
      return settle(kinSendEditRefused(shownEdit, choice, squashAtomCommandFailure(result)));
    if (AsyncResult.isSuccess(result))
      setAck({ revision: result.value.revision, saved: shownEdit.draft });
    settle(
      stay && AsyncResult.isSuccess(result)
        ? kinSendEditKept(shownEdit, result.value.revision)
        : null,
      null,
    );
  };
  const discardEdit = async () => {
    if (shownEdit === null || editBusy !== null) return;
    const input = kinSendEditDiscardInput(choice, shownEdit, editable);
    if (input === null) return settle(null);
    setEditBusy("discarding");
    const result = await saveEdited({ environmentId, input });
    setEditBusy(null);
    if (AsyncResult.isSuccess(result)) setAck({ revision: result.value.revision, saved: null });
    settle(
      AsyncResult.isFailure(result)
        ? kinSendEditRefused(shownEdit, choice, squashAtomCommandFailure(result))
        : null,
    );
  };
  const leave = useEffectEvent(() => {
    if (kinSendEditLeaveSaves(shownEdit, editBusy, editable)) void saveEdit(true);
    else if (shownEdit !== null && kinSendEditUnsaved(shownEdit))
      kinSendEditHold(heldKey, shownEdit);
  });
  const navigation = useNavigation();
  const editorOpen = shownEdit !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- unsaved words are kept when the app goes to the background, the chat loses focus or is left.
  useEffect(() => {
    if (!editorOpen) return;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "background") leave();
    });
    // Opening another chat or a task from this one keeps this screen mounted, out of focus.
    const blurred = navigation.addListener("blur", () => leave());
    return () => {
      subscription.remove();
      blurred();
      leave();
    };
  }, [editorOpen, navigation]);
  const edited = kinSendEditedLine(choice, props.viewerPersonId);

  const fromPicker =
    choice.send !== null &&
    phase === "open" &&
    canAct &&
    answered === null &&
    choice.send.fromChoices.length > 1
      ? { busy: switching, problem: switchProblem, pick: (id: string) => void pickFrom(id) }
      : null;

  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <View
        // Grouped for VoiceOver, except while Change or the editor sits inside: a group hides them.
        accessible={fromPicker === null && shownEdit === null}
        accessibilityLabel={kinChoiceAccessibilityLabel(choice, answered?.text ?? takes, edited, {
          message: true,
        })}
        className="gap-1.5"
      >
        <Text textRole="headline" className="font-t3-bold text-foreground">
          {choice.question}
        </Text>
        {takes === null ? null : (
          <Text textRole="footnote" className="text-foreground-secondary">
            {takes}
          </Text>
        )}
        {choice.send !== null && shownEdit !== null ? (
          <SendEditor
            send={choice.send}
            draft={shownEdit.draft}
            busy={editBusy !== null}
            problem={shownEdit.problem}
            review={editBound?.review === true}
            controls={kinSendEditControls(shownEdit, choice, editBusy, editable)}
            onChange={(draft) => setEditing({ ...shownEdit, draft })}
            onSave={() => void saveEdit()}
            onSend={() => void sendEdit()}
            onDiscard={() => void discardEdit()}
          />
        ) : choice.send !== null ? (
          <SendDetail send={choice.send} edited={edited} pickFrom={fromPicker} />
        ) : choice.detail === null ? null : (
          <Text textRole="footnote" className="text-foreground-secondary">
            {choice.detail}
          </Text>
        )}
      </View>
      {choice.image === null ? null : (
        <ChoiceImage environmentId={environmentId} image={choice.image} />
      )}
      {answered !== null ? (
        answered.text === null ? null : (
          <Text
            textRole="footnote"
            className="font-t3-medium text-foreground-secondary"
            importantForAccessibility="no"
            accessibilityElementsHidden
          >
            {answered.text}
          </Text>
        )
      ) : phase === "expired" ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {choice.closedText}
        </Text>
      ) : !canAct ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {KIN_DEVICE_COPY.cantAct("phone", "answer")}
        </Text>
      ) : shownEdit !== null ? null : (
        <>
          {status?.notice == null ? null : (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              textRole="footnote"
              className={cn(
                "font-t3-medium",
                status.notice.kind === "stale"
                  ? "text-warning-foreground"
                  : "text-danger-foreground",
              )}
            >
              {status.notice.text}
            </Text>
          )}
          <View className="gap-2 pt-1">
            {choice.options.map((option) => (
              <View key={option.id} className="gap-0.5">
                <Button
                  label={option.label}
                  accessibilityHint={option.action ?? "Sends this as your reply"}
                  tone="outline"
                  size="compact"
                  fullWidth
                  loading={pending === option.id}
                  disabled={(pending !== null && pending !== option.id) || switching}
                  onPress={() => void press(option.id)}
                />
                {option.action === null ? null : (
                  <Text textRole="footnote" className="px-1 text-foreground-muted">
                    {option.action}
                  </Text>
                )}
              </View>
            ))}
            {editable ? (
              <Button
                label={KIN_SEND_EDIT_COPY.edit}
                accessibilityHint={KIN_SEND_EDIT_COPY.editHint}
                tone="outline"
                size="compact"
                fullWidth
                disabled={switching}
                onPress={() =>
                  setEditing(kinSendEditHeld(heldKey) ?? kinSendEditStart(choice, ack))
                }
              />
            ) : null}
          </View>
        </>
      )}
      {undone === null ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {undone}
        </Text>
      )}
    </View>
  );
});
