import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinShadowVerdict } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { memo, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Chip } from "../../../components/ui/Chip";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
import {
  KIN_VERDICTS,
  kinLevelsFailureText,
  kinShownVerdict,
  type KinShadowReviewCardView,
  type KinShadowReviewEntryView,
} from "./kinLevelsPresentation";

/** The evening trial review: each shadow entry with the owner's verdict. Taps call `kin.levels.review`. */
export const KinShadowReviewCard = memo(function KinShadowReviewCard(props: {
  readonly review: KinShadowReviewCardView;
  readonly environmentId: EnvironmentId;
}) {
  const { review, environmentId } = props;
  const canReview = useAtomValue(kinClient.review.permissionAtom(environmentId));
  const send = useAtomCommand(kinClient.review, { reportFailure: false });
  const [local, setLocal] = useState<{
    readonly revision: number;
    readonly verdicts: ReadonlyMap<string, KinShadowVerdict>;
  }>({ revision: review.revision, verdicts: new Map() });
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    readonly entryId: string;
    readonly text: string;
    readonly error: boolean;
  } | null>(null);

  const choose = async (entry: KinShadowReviewEntryView, verdict: KinShadowVerdict) => {
    if (pending !== null) return;
    setPending(entry.entryId);
    setNotice(null);
    const result = await send({
      environmentId,
      input: { orgId: review.orgId, entryId: entry.entryId, verdict },
    });
    setPending(null);
    if (AsyncResult.isFailure(result)) {
      setNotice({
        entryId: entry.entryId,
        text: kinLevelsFailureText(squashAtomCommandFailure(result)),
        error: true,
      });
      return;
    }
    setLocal((current) => {
      const verdicts = new Map(current.revision === review.revision ? current.verdicts : []);
      verdicts.set(entry.entryId, verdict);
      return { revision: review.revision, verdicts };
    });
    if (AsyncResult.isSuccess(result) && result.value.loweredTo !== null) {
      setNotice({
        entryId: entry.entryId,
        text: `Marked Harmful, so the lead went down to ${result.value.loweredTo}.`,
        error: false,
      });
    }
  };

  return (
    <View className="gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View accessible className="gap-1">
        <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
          Trial review
        </Text>
        <Text textRole="headline" className="font-t3-bold text-foreground">
          {review.title}
        </Text>
        <Text textRole="footnote" className="text-foreground-secondary">
          {review.summary}
        </Text>
      </View>
      {review.entries.map((entry) => {
        const shown = kinShownVerdict(entry, review.revision, local);
        const busy = pending === entry.entryId;
        return (
          <View key={entry.entryId} className="gap-1.5 border-t border-border pt-3">
            <View accessible accessibilityLabel={entry.accessibilityLabel} className="gap-1">
              <Text textRole="footnote" className="font-t3-medium text-foreground-secondary">
                {entry.heading}
              </Text>
              {entry.target === null ? null : (
                <Text textRole="caption" className="text-foreground-muted">
                  {`Would reach ${entry.target}`}
                </Text>
              )}
              <Text textRole="footnote" className="text-foreground" selectable>
                {entry.preview}
              </Text>
              {entry.truncated ? (
                <Text textRole="caption" className="text-foreground-muted">
                  Cut short, so it can't be marked Fine as is.
                </Text>
              ) : null}
            </View>
            {review.closed || !canReview ? (
              shown === null ? null : (
                <Text textRole="caption" className="font-t3-medium text-foreground-secondary">
                  {`Marked ${KIN_VERDICTS.find((option) => option.verdict === shown)!.label}`}
                </Text>
              )
            ) : (
              <View className="flex-row flex-wrap gap-2 pt-1">
                {KIN_VERDICTS.map((option) => (
                  <Chip
                    key={option.verdict}
                    size="small"
                    label={option.label}
                    accessibilityLabel={`Mark ${option.label}`}
                    selected={shown === option.verdict}
                    disabled={pending !== null || (option.verdict === "fine" && entry.truncated)}
                    onPress={() => void choose(entry, option.verdict)}
                  />
                ))}
              </View>
            )}
            {busy ? (
              <Text textRole="caption" className="text-foreground-muted">
                Saving…
              </Text>
            ) : notice?.entryId === entry.entryId ? (
              <Text
                accessibilityRole={notice.error ? "alert" : undefined}
                accessibilityLiveRegion="polite"
                textRole="caption"
                className={
                  notice.error
                    ? "font-t3-medium text-danger-foreground"
                    : "font-t3-medium text-warning-foreground"
                }
              >
                {notice.text}
              </Text>
            ) : null}
          </View>
        );
      })}
      {review.more === null ? null : (
        <Text textRole="caption" className="text-foreground-muted">
          {review.more}
        </Text>
      )}
      <View className="gap-0.5 border-t border-border pt-3">
        {review.trial.map((line) => (
          <Text key={line} textRole="caption" className="text-foreground-muted">
            {line}
          </Text>
        ))}
      </View>
      {canReview || review.closed ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          This device can't review Kin entries. Pair it again from the Mac.
        </Text>
      )}
    </View>
  );
});
