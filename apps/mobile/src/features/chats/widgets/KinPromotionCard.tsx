import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { memo, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { useAtomCommand } from "../../../state/use-atom-command";
import { appAtomRegistry } from "../../../state/atom-registry";
import { kinClient } from "../state/kinClient";
import {
  KIN_PROMOTION_SENT,
  kinLevelsFailure,
  kinLevelsFailureText,
  type KinPromotionActionId,
  type KinPromotionCardView,
} from "./kinLevelsPresentation";

type Notice = { readonly revision: number; readonly text: string; readonly error: boolean };

/** "<name> is ready for L1", then the raise, its approval, and what to do with shadow memory. */
export const KinPromotionCard = memo(function KinPromotionCard(props: {
  readonly promotion: KinPromotionCardView;
  readonly environmentId: EnvironmentId;
}) {
  const { promotion, environmentId } = props;
  // Raise and shadow memory need settings:write; Another week needs orchestration:operate.
  const canRaise = useAtomValue(kinClient.raise.permissionAtom(environmentId));
  const canDefer = useAtomValue(kinClient.deferPromotion.permissionAtom(environmentId));
  const canChooseMemory = useAtomValue(kinClient.shadowMemory.permissionAtom(environmentId));
  const raise = useAtomCommand(kinClient.raise, { reportFailure: false });
  const defer = useAtomCommand(kinClient.deferPromotion, { reportFailure: false });
  const shadowMemory = useAtomCommand(kinClient.shadowMemory, { reportFailure: false });
  const [pending, setPending] = useState<KinPromotionActionId | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // A notice belongs to the revision it was raised on; the server's redraw replaces it.
  const shown = notice?.revision === promotion.revision ? notice : null;
  const holding = shown !== null && !shown.error;

  const press = async (id: KinPromotionActionId) => {
    if (pending !== null) return;
    setPending(id);
    setNotice(null);
    const lead = { orgId: promotion.orgId, agentId: promotion.agentId };
    const target = promotion.target;
    const result =
      id === "raise"
        ? target === null
          ? null
          : await raise({ environmentId, input: { ...lead, level: target } })
        : id === "defer"
          ? await defer({ environmentId, input: lead })
          : await shadowMemory({
              environmentId,
              input: { ...lead, choice: id === "keep" ? "keep" : "discard" },
            });
    setPending(null);
    if (result === null) return;
    const failure = kinLevelsFailure(result);
    const failed = failure !== null;
    setNotice({
      revision: promotion.revision,
      text: failed ? kinLevelsFailureText(failure) : KIN_PROMOTION_SENT[id],
      error: failed,
    });
    if (!failed) appAtomRegistry.refresh(kinClient.levels({ environmentId, input: lead }));
  };

  const allowed = (id: KinPromotionActionId) =>
    id === "defer" ? canDefer : id === "raise" ? canRaise : canChooseMemory;
  const actions = promotion.actions.filter((action) => allowed(action.id));

  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <View accessible accessibilityLabel={promotion.accessibilityLabel} className="gap-1.5">
        <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
          {promotion.eyebrow}
        </Text>
        <Text textRole="headline" className="font-t3-bold text-foreground">
          {promotion.title}
        </Text>
        {promotion.lines.map((line) => (
          <Text key={line} textRole="footnote" className="text-foreground-secondary">
            {line}
          </Text>
        ))}
        {promotion.paths.map((path) => (
          <Text key={path} textRole="caption" className="text-foreground-muted" selectable>
            {promotion.ownerReviewed.includes(path) ? `${path} (needs a PR)` : path}
          </Text>
        ))}
      </View>
      {shown === null ? null : (
        <Text
          accessibilityRole={shown.error ? "alert" : undefined}
          accessibilityLiveRegion="polite"
          textRole="footnote"
          className={
            shown.error
              ? "font-t3-medium text-danger-foreground"
              : "font-t3-medium text-foreground-muted"
          }
        >
          {shown.text}
        </Text>
      )}
      {promotion.actions.length > 0 && actions.length < promotion.actions.length ? (
        <Text textRole="footnote" className="text-foreground-muted">
          This device can't change levels. Pair it again from the Mac.
        </Text>
      ) : null}
      {actions.length === 0 ? null : (
        <View className="flex-row flex-wrap gap-2 pt-1">
          {actions.map((action) => (
            <Button
              key={action.id}
              label={action.label}
              tone={action.tone}
              loading={pending === action.id}
              disabled={action.disabled || holding || (pending !== null && pending !== action.id)}
              onPress={() => void press(action.id)}
            />
          ))}
        </View>
      )}
    </View>
  );
});
