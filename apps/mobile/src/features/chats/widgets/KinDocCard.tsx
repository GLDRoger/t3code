import { useNavigation } from "@react-navigation/native";
import {
  KIN_DOCS,
  kinDocCardDraft,
  kinDocCardLine,
  kinDocSendUpProblem,
  kinDocWholeCopy,
  type KinDocCardDraftView,
  type KinDocCardView,
} from "@t3tools/client-runtime/kin/kinDocs";
import { type EnvironmentId, KinRecordKey } from "@t3tools/contracts";
import { memo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Chip } from "../../../components/ui/Chip";
import { useNowMinuteMs } from "../../../lib/clock";
import { tryCopyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
import { useKinWorkLink } from "../state/kinWorkLink";
import { kinHostConnected } from "../state/useKinHost";

const NO_NAMES: ReadonlyMap<string, string> = new Map();

/**
 * A doc an agent wrote or changed: what it is, what changed, and the way to read either; a tap
 * opens it. A draft also copies its text and, for the teammate it's for, goes up to the owner.
 */
export const KinDocCard = memo(function KinDocCard(props: {
  readonly doc: KinDocCardView;
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
  /** The owner or a co-owner: nothing to send up, so Copy text only. */
  readonly ownerLevel: boolean;
  /** The viewer may only read this chat: no Send to. */
  readonly readOnly: boolean;
  readonly agentNames?: ReadonlyMap<string, string>;
  /** The message's own long press: the card takes presses across its face, so it passes this on. */
  readonly onLongPress?: () => void;
}) {
  const { doc } = props;
  const navigation = useNavigation();
  const openRecord = useKinWorkLink();
  const line = kinDocCardLine(doc, props.agentNames ?? NO_NAMES, new Date(useNowMinuteMs()));
  const where = { environmentId: props.environmentId, orgId: props.orgId, doc: doc.key };
  const open = () => openRecord("KinDoc", where);
  const { previousVersion } = doc;
  const draft = kinDocCardDraft(doc, props.ownerLevel, props.readOnly);
  const sendUp = useAtomCommand(kinClient.docSendUp, { reportFailure: false });
  const readVersion = useAtomCommand(kinClient.docVersion, { reportFailure: false });
  const [sending, setSending] = useState(false);
  const [copying, setCopying] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const copy = async (text: string) => {
    if (await tryCopyTextWithHaptic(text, { target: "text" })) setSaid(KIN_DOCS.textCopied);
  };
  // A long draft's card holds its opening: Copy text takes the whole of that version.
  const copyDraft = async (shown: KinDocCardDraftView) => {
    if (shown.long === undefined) return copy(shown.copyText);
    if (copying) return;
    setCopying(true);
    setSaid(null);
    const got = kinDocWholeCopy(
      await readVersion({
        environmentId: props.environmentId,
        input: { orgId: doc.orgId, key: KinRecordKey.make(doc.key), version: shown.long.version },
      }),
    );
    setCopying(false);
    if ("problem" in got) return setSaid(got.problem);
    await copy(got.text);
  };
  const send = async () => {
    if (sending) return;
    if (!kinHostConnected(props.environmentId)) return setSaid(KIN_DOCS.sendOffline);
    setSending(true);
    setSaid(null);
    const result = await sendUp({
      environmentId: props.environmentId,
      input: { orgId: doc.orgId, chatId: doc.chatId, widgetId: doc.widgetId },
    });
    setSending(false);
    setSaid(kinDocSendUpProblem(result));
  };
  const eyebrow = draft === null ? "Doc" : KIN_DOCS.draft;
  const changes =
    previousVersion === null
      ? null
      : () =>
          navigation.navigate("KinDocChanges", {
            ...where,
            to: String(doc.version),
            from: String(previousVersion),
          });
  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${eyebrow}: ${doc.title}. ${line.text}`}
      accessibilityHint="Opens the doc."
      accessibilityActions={[
        { name: "activate", label: "Open" },
        ...(changes === null ? [] : [{ name: "changes", label: KIN_DOCS.changes }]),
      ]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "changes") changes?.();
        else open();
      }}
      onPress={open}
      {...(props.onLongPress === undefined ? {} : { onLongPress: props.onLongPress })}
      className="gap-2 rounded-[20px] border border-border bg-card-alt p-4 active:opacity-70"
    >
      <Text textRole="caption" className="font-t3-medium text-foreground-muted">
        {eyebrow}
      </Text>
      <Text textRole="body" className="font-t3-bold text-foreground">
        {doc.title}
      </Text>
      <Text textRole="footnote" className="text-foreground-muted">
        {line.text}
      </Text>
      {draft?.noAccount == null ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {draft.noAccount}
        </Text>
      )}
      {draft?.long === undefined ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {draft.long.line}
        </Text>
      )}
      {draft?.sent == null ? null : (
        <Text textRole="footnote" className="text-foreground">
          {draft.sent}
        </Text>
      )}
      {said === null ? null : (
        <Text
          textRole="footnote"
          className="text-foreground-muted"
          accessibilityLiveRegion="polite"
        >
          {said}
        </Text>
      )}
      <View className="flex-row flex-wrap gap-2 pt-1">
        <Chip size="small" label="Open" onPress={open} />
        {draft === null ? null : (
          <Chip
            size="small"
            label={copying ? KIN_DOCS.copying : KIN_DOCS.copyText}
            disabled={copying}
            onPress={() => void copyDraft(draft)}
          />
        )}
        {draft?.sendTo == null ? null : (
          <Chip
            size="small"
            label={sending ? KIN_DOCS.sending : draft.sendTo}
            disabled={sending}
            onPress={() => void send()}
          />
        )}
        {changes === null ? null : <Chip size="small" label={KIN_DOCS.changes} onPress={changes} />}
      </View>
    </Pressable>
  );
});
