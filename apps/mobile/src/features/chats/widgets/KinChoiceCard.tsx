import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import { KIN_CARD_COPY } from "@t3tools/client-runtime/kin/kinCardPresentation";
import { kinBodyMarkdown } from "@t3tools/client-runtime/kin/kinChatFeed";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, KinPersonId, KinSendTry } from "@t3tools/contracts";
import { Image as ExpoImage } from "expo-image";
import { memo, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { Alert, AppState, Pressable, TextInput, View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../lib/cn";
import { SelectableMarkdownText } from "../../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../../files/FileMarkdownPreview";
import { assetImageSource } from "../../../lib/assetImageSource";
import { useNowMinuteMs } from "../../../lib/clock";
import { uuidv4 } from "../../../lib/uuid";
import { useAssetUrl, useRefreshAssetUrl } from "../../../state/assets";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
import {
  kinAddressPieces,
  kinChoiceCardActions,
  kinChoiceCardTaps,
  kinChoiceAccessibilityLabel,
  kinChoiceAnswered,
  kinChoiceDecidedLine,
  kinChoicePhase,
  kinChoiceUndoneLine,
  createKinHeldPress,
  kinDeviceTimers,
  kinMailCancels,
  KIN_MAIL_CANCEL_COPY,
  KIN_MAIL_CANCEL_UNDO_MS,
  kinSendEditBound,
  kinSendEditControls,
  kinSendEditedLine,
  kinSendEditHeld,
  kinSendEditHeldKey,
  kinSendEditHold,
  kinSendEditLeaveSaves,
  kinSendEditOffered,
  kinSendEditShown,
  kinSendEditStart,
  kinSendEditUnsaved,
  kinSendEditWarned,
  kinSendCheckPending,
  kinSendTicked,
  KIN_SEND_CHECKED,
  KIN_SEND_COPY,
  KIN_SEND_EDIT_COPY,
  KIN_CHOICE_DRAFT_COPY,
  KIN_CHOICE_OPEN_LABEL,
  type KinChoiceDraftView,
  type KinChoiceOpen,
  type KinSendEditBusy,
  type KinChoiceCardStatus,
  type KinChoiceCardView,
  type KinSendEditDraft,
  type KinSendEditAck,
  type KinSendEditing,
} from "@t3tools/client-runtime/kin/kinChoicePresentation";
import { visibleKinCardStatus } from "@t3tools/client-runtime/kin/kinDeferralPresentation";

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

/** Exactly what a send card sends: who, the subject, each file and, unless it folds, the body. */
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
      {send.folds ? null : <SendMessage body={send.body} quoted={send.quoted} />}
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
      {send.noBank === null ? null : (
        <Text textRole="footnote" className="text-warning-foreground">
          {send.noBank}
        </Text>
      )}
      {props.edited === null ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {props.edited}
        </Text>
      )}
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

/** A mail's whole body, folded under its card's first screen so Confirm is in reach. */
/** A teammate's sent-up draft, rendered as a doc is; a long one opens under Show all. */
function ChoiceDraft(props: { readonly draft: KinChoiceDraftView }) {
  const { draft } = props;
  const [open, setOpen] = useState(false);
  const styles = useMarkdownPreviewStyles();
  const line = (text: string | null) =>
    text === null ? null : (
      <Text textRole="footnote" className="text-foreground-secondary">
        {text}
      </Text>
    );
  return (
    <View className="gap-2">
      {line(draft.before)}
      <View className="rounded-lg border border-border-subtle px-3 py-2">
        <SelectableMarkdownText
          markdown={kinBodyMarkdown(draft.folds && !open ? draft.preview : draft.markdown)}
          textStyle={styles.nativeTextStyle}
          selectable
        />
        {draft.folds ? (
          <View className="flex-row">
            <Button
              tone="text"
              size="compact"
              label={open ? KIN_CHOICE_DRAFT_COPY.showLess : KIN_CHOICE_DRAFT_COPY.showAll}
              onPress={() => setOpen(!open)}
            />
          </View>
        ) : null}
      </View>
      {line(draft.after)}
    </View>
  );
}

function SendFold(props: { readonly send: NonNullable<KinChoiceCardView["send"]> }) {
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-2">
      <View className="flex-row">
        <Button
          tone="text"
          size="compact"
          label={open ? KIN_SEND_COPY.hideAll : KIN_SEND_COPY.readAll}
          onPress={() => setOpen(!open)}
        />
      </View>
      {open ? <SendMessage body={props.send.body} quoted={props.send.quoted} /> : null}
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
          accessibilityLabel={KIN_SEND_EDIT_COPY.bodyName}
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

/** An earlier try at this mail may have gone: the closed card's warning, and the tick Confirm needs. */
function SendMayHaveGone(props: {
  readonly line: string;
  /** The card's spoken label says the line; ungrouped (editing, picking From), the line speaks. */
  readonly grouped: boolean;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <View className="gap-1.5">
      <Text
        textRole="footnote"
        className="font-t3-medium text-danger-foreground"
        importantForAccessibility={props.grouped ? "no" : "auto"}
        accessibilityElementsHidden={props.grouped}
      >
        {props.line}
      </Text>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: props.checked, disabled: props.disabled }}
        accessibilityLabel={KIN_SEND_CHECKED}
        disabled={props.disabled}
        onPress={() => props.onChange(!props.checked)}
        className="min-h-11 flex-row items-center gap-3 active:opacity-70"
      >
        <SymbolView
          name={props.checked ? "checkmark.circle.fill" : "circle"}
          size={20}
          tintColorClassName={props.checked ? "accent-primary" : "accent-icon-muted"}
          type="monochrome"
        />
        <Text textRole="footnote" className="min-w-0 flex-1 text-foreground">
          {KIN_SEND_CHECKED}
        </Text>
      </Pressable>
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
  const [taps] = useState(kinChoiceCardTaps);
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
  const [lastStatus, setLastStatus] = useState<KinChoiceCardStatus>(null);
  // The try the person ticked they checked the sent mail for; the press reads it when it posts.
  // It counts only while the card's warning names that try (`kinSendTicked`).
  const [ticked, setTicked] = useState<KinSendTry | null>(null);
  const status = visibleKinCardStatus(lastStatus, choice.revision);
  const phase = kinChoicePhase(choice, nowMs);
  // Until the answered card arrives, the tapped option already reads as chosen.
  const sentOption =
    status?.holding === true
      ? choice.options.find((option) => option.id === lastStatus?.optionId)
      : undefined;

  const answered = kinChoiceAnswered(choice, props.viewerPersonId, sentOption?.label ?? null);
  const editable =
    answered === null && pending === null && kinSendEditOffered(choice, phase, canAct && canEdit);
  const shownEdit = kinSendEditShown(editing, editable) ? editing : null;
  const editBound = shownEdit === null ? null : kinSendEditBound(shownEdit, choice);
  // The tick answers the press on screen: the editor's for the words typed, else the card's.
  const warnedView = kinSendEditWarned(choice, shownEdit, new Date(nowMs));
  const checked = kinSendTicked(warnedView, ticked) !== null;
  const undone = kinChoiceUndoneLine(choice, props.viewerPersonId, new Date(nowMs));

  const { tick, press, pickFrom, sendEdit, saveEdit, discardEdit } = kinChoiceCardActions({
    choice,
    environmentId,
    newId: uuidv4,
    taps,
    heldKey,
    state: { pending, switching, editing: shownEdit, editBusy, editable, ticked, nowMs },
    commands: { post, setSendFrom, sendEdited, saveEdited },
    set: {
      pending: setPending,
      lastStatus: setLastStatus,
      switching: setSwitching,
      switchProblem: setSwitchProblem,
      editBusy: setEditBusy,
      editing: setEditing,
      ack: setAck,
      ticked: setTicked,
    },
  });
  const leave = useEffectEvent(() => {
    if (kinSendEditLeaveSaves(shownEdit, editBusy, editable)) void saveEdit(true);
    else if (shownEdit !== null && kinSendEditUnsaved(shownEdit))
      kinSendEditHold(heldKey, shownEdit);
  });
  const navigation = useNavigation();
  const openMade = (open: KinChoiceOpen) => {
    const target = { environmentId: String(environmentId), orgId: String(choice.orgId) };
    if (open.subscriptions === true) navigation.navigate("KinSubscriptions", target);
    else navigation.navigate("KinList", { ...target, list: open.list });
  };
  const made = choice.outcome?.open ?? null;
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
  const decided = kinChoiceDecidedLine(choice, props.viewerPersonId);
  // A mail's Cancel, once said yes to, waits a few seconds for Undo before it is sent.
  const [held, setHeld] = useState<string | null>(null);
  const sendHeld = useEffectEvent(() => {
    const optionId = held;
    setHeld(null);
    if (optionId !== null) void press(optionId);
  });
  const [heldPress] = useState(() =>
    createKinHeldPress({
      delayMs: KIN_MAIL_CANCEL_UNDO_MS,
      send: () => sendHeld(),
      timers: kinDeviceTimers,
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a held Cancel is sent when its card leaves the screen.
  useEffect(() => () => heldPress.flush(), [heldPress]);
  const choose = (optionId: string) => {
    if (!kinMailCancels(choice, optionId)) return void press(optionId);
    Alert.alert(KIN_MAIL_CANCEL_COPY.ask, KIN_MAIL_CANCEL_COPY.detail, [
      { text: KIN_MAIL_CANCEL_COPY.no, style: "cancel" },
      {
        text: KIN_MAIL_CANCEL_COPY.yes,
        style: "destructive",
        onPress: () => {
          setHeld(optionId);
          heldPress.hold();
        },
      },
    ]);
  };

  const fromPicker =
    choice.send !== null &&
    phase === "open" &&
    canAct &&
    answered === null &&
    choice.send.fromChoices.length > 1
      ? { busy: switching, problem: switchProblem, pick: (id: string) => void pickFrom(id) }
      : null;

  const grouped = fromPicker === null && shownEdit === null;
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <View
        // Grouped for VoiceOver, except while Change or the editor sits inside: a group hides them.
        accessible={grouped}
        accessibilityLabel={kinChoiceAccessibilityLabel(choice, answered?.text ?? null, edited, {
          message: true,
        })}
        className="gap-1.5"
      >
        {choice.askedBy === null ? null : (
          <Text textRole="footnote" className="text-foreground-secondary">
            {choice.askedBy}
          </Text>
        )}
        <Text textRole="headline" className="font-t3-bold text-foreground">
          {choice.question}
        </Text>
        {choice.send !== null && shownEdit !== null ? (
          <SendEditor
            send={choice.send}
            draft={shownEdit.draft}
            busy={editBusy !== null}
            problem={shownEdit.problem}
            review={editBound?.review === true}
            controls={kinSendEditControls(
              shownEdit,
              choice,
              editBusy,
              editable,
              kinSendCheckPending(warnedView, ticked),
            )}
            onChange={(draft) => setEditing({ ...shownEdit, draft })}
            onSave={() => void saveEdit()}
            onSend={() => void sendEdit()}
            onDiscard={() => void discardEdit()}
          />
        ) : choice.send !== null ? (
          <SendDetail send={choice.send} edited={edited} pickFrom={fromPicker} />
        ) : choice.draft !== null ? (
          <ChoiceDraft draft={choice.draft} />
        ) : choice.detail === null ? null : (
          <Text textRole="footnote" className="text-foreground-secondary">
            {choice.detail}
          </Text>
        )}
      </View>
      {choice.send !== null && shownEdit === null && choice.send.folds ? (
        <SendFold send={choice.send} />
      ) : null}
      {choice.image === null ? null : (
        <ChoiceImage environmentId={environmentId} image={choice.image} />
      )}
      {warnedView.send?.mayHaveGone == null || answered !== null || phase !== "open" ? null : (
        <SendMayHaveGone
          line={warnedView.send.mayHaveGone.line}
          grouped={grouped}
          checked={checked}
          disabled={!canAct || pending !== null || editBusy !== null}
          onChange={tick}
        />
      )}
      {answered !== null ? (
        answered.text === null ? null : (
          <View className="gap-1">
            <Text
              textRole="footnote"
              className="font-t3-medium text-foreground-secondary"
              importantForAccessibility="no"
              accessibilityElementsHidden
            >
              {answered.text}
            </Text>
            {made === null ? null : (
              <View className="flex-row">
                <Button
                  tone="text"
                  size="compact"
                  label={KIN_CHOICE_OPEN_LABEL}
                  onPress={() => openMade(made)}
                />
              </View>
            )}
          </View>
        )
      ) : phase === "expired" ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {choice.closedText}
        </Text>
      ) : !canAct ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {KIN_DEVICE_COPY.cantAct("phone", "answer")}
        </Text>
      ) : shownEdit !== null ? null : held !== null ? (
        <View className="flex-row items-center gap-3 pt-1">
          <Text
            accessibilityLiveRegion="polite"
            textRole="footnote"
            className="min-w-0 flex-1 font-t3-medium text-foreground-secondary"
          >
            {KIN_MAIL_CANCEL_COPY.held}
          </Text>
          <Button
            label={KIN_MAIL_CANCEL_COPY.undo}
            tone="outline"
            size="compact"
            onPress={() => {
              heldPress.undo();
              setHeld(null);
            }}
          />
        </View>
      ) : (
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
                  disabled={
                    (pending !== null && pending !== option.id) ||
                    switching ||
                    kinSendCheckPending(choice, ticked, option.id)
                  }
                  onPress={() => choose(option.id)}
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
      {decided === null ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {decided}
        </Text>
      )}
      {undone === null ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {undone}
        </Text>
      )}
    </View>
  );
});
