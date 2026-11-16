import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinPersonId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Image as ExpoImage } from "expo-image";
import { memo, useRef, useState } from "react";
import { Pressable, View } from "react-native";

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
import { kinConnectionChange } from "@t3tools/client-runtime/kin/kinConnections";
import {
  kinChoiceAccessibilityLabel,
  kinChoiceActInput,
  kinChoiceAnswered,
  kinChoiceFailureNotice,
  kinChoicePhase,
  type KinChoiceCardView,
} from "@t3tools/client-runtime/kin/kinChoicePresentation";
import {
  createKinCardActions,
  visibleKinCardStatus,
  type KinCardStatus,
} from "@t3tools/client-runtime/kin/kinDeferralPresentation";

// A mid grey: a white logo and a black one both stand out on it, in light and dark themes.
const IMAGE_GROUND = "#8c8c8c";

/** Exactly what a send card sends: who, the subject, the whole body and each file. */
function SendDetail(props: {
  readonly send: NonNullable<KinChoiceCardView["send"]>;
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
      <View className="gap-0.5">
        {send.lines.map((line) => (
          <View key={line.label} className="flex-row items-center gap-2">
            <Text textRole="footnote" className="flex-1 text-foreground">
              <Text textRole="footnote" className="text-foreground-muted">
                {line.label}{" "}
              </Text>
              {line.value}
            </Text>
            {line.label === "From" && pickFrom !== null ? (
              <Button
                label={choosing ? "Done" : "Change"}
                accessibilityHint="Pick another address to send from"
                tone="text"
                size="compact"
                loading={pickFrom.busy}
                onPress={() => setChoosing(!choosing)}
              />
            ) : null}
          </View>
        ))}
      </View>
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
      <View className="rounded-xl bg-subtle px-3 py-2">
        <Text textRole="body" className="text-foreground" selectable>
          {send.body}
        </Text>
        {send.quoted === null ? null : (
          <Text textRole="footnote" className="mt-3 text-foreground-muted" selectable>
            {send.quoted}
          </Text>
        )}
      </View>
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
          The picture couldn't load. Open the chat to see the file.
        </Text>
      ) : uri === null ? (
        <AppActivityIndicator />
      ) : (
        <ExpoImage
          source={assetImageSource(props.environmentId, resource, uri)}
          contentFit="contain"
          accessibilityLabel="The picture this question is about"
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
        // Grouped for VoiceOver, except while Change sits inside: a group hides its buttons.
        accessible={fromPicker === null}
        accessibilityLabel={kinChoiceAccessibilityLabel(choice, answered?.text ?? null)}
        className="gap-1.5"
      >
        <Text textRole="headline" className="font-t3-bold text-foreground">
          {choice.question}
        </Text>
        {choice.send !== null ? (
          <SendDetail send={choice.send} pickFrom={fromPicker} />
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
          This phone can't answer here. Pair it again with the computer that runs T3 Code.
        </Text>
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
              <Button
                key={option.id}
                label={option.label}
                accessibilityHint="Sends this as your reply"
                tone="outline"
                size="compact"
                fullWidth
                loading={pending === option.id}
                disabled={(pending !== null && pending !== option.id) || switching}
                onPress={() => void press(option.id)}
              />
            ))}
          </View>
        </>
      )}
    </View>
  );
});
