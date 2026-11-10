import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  kinApprovalCardView,
  kinApprovalFailure,
  type KinApprovalBusy,
  type KinApprovalCardView,
  type KinApprovalFailure,
} from "@t3tools/client-runtime/kin/kinApprovalPresentation";
import type {
  EnvironmentId,
  KinActionId,
  KinApprovalView,
  KinPendingActionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { memo, useState, type ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../lib/cn";
import { appAtomRegistry } from "../../../state/atom-registry";
import { useDecidePendingAction, useKinApproverKey } from "../approvals/useKinApproverKey";
import { kinClient } from "../state/kinClient";

const CHECK_TONE = {
  passed: "text-foreground-secondary",
  failed: "text-danger-foreground",
  pending: "text-foreground-muted",
  skipped: "text-foreground-muted",
} as const;

/**
 * A privileged request, drawn only from the host's record of it (`kin.approvals.get`). The owner
 * approves with Face ID on this phone's approval key; anyone else sees whom it waits on.
 */
export const KinApprovalCard = memo(function KinApprovalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly actionId: KinActionId;
  /** The chat card's revision: a redraw reads the action again. */
  readonly revision: number;
}) {
  const { environmentId, actionId, revision } = props;
  const atom = kinClient.approval({ environmentId, input: { actionId, revision } });
  const result = useAtomValue(atom);
  const refresh = () => appAtomRegistry.refresh(atom);
  if (AsyncResult.isInitial(result))
    return (
      <Frame label="Approval, loading">
        <Text textRole="footnote" className="text-foreground-muted">
          Loading the request…
        </Text>
      </Frame>
    );
  if (AsyncResult.isFailure(result))
    return (
      <Frame label="Approval">
        <Text textRole="footnote" accessibilityRole="alert" className="text-foreground-secondary">
          {kinApprovalFailure(Cause.squash(result.cause))?.text ?? "Kin didn't answer."}
        </Text>
        <View className="flex-row pt-1">
          <Button
            tone="secondary"
            size="compact"
            label="Retry"
            loading={result.waiting}
            onPress={refresh}
          />
        </View>
      </Frame>
    );
  const view = result.value;
  return view._tag === "full" ? (
    <OwnerCard view={view} environmentId={environmentId} refresh={refresh} />
  ) : (
    <CardBody card={kinApprovalCardView(view)} />
  );
});

function OwnerCard(props: {
  readonly view: Extract<KinApprovalView, { _tag: "full" }>;
  readonly environmentId: EnvironmentId;
  readonly refresh: () => void;
}) {
  const { view, environmentId, refresh } = props;
  const { action } = view;
  const navigation = useNavigation();
  const { status: key } = useKinApproverKey(environmentId, action.orgId);
  const { approve, reject } = useDecidePendingAction();
  const canDecide = useAtomValue(kinClient.submitGrant.permissionAtom(environmentId));
  const [busy, setBusy] = useState<KinApprovalBusy | null>(null);
  // The answer belongs to the revision it was given on; a redraw at a new revision replaces it.
  const [decided, setDecided] = useState<{
    readonly revision: number;
    readonly state: KinPendingActionState;
  } | null>(null);
  const [failure, setFailure] = useState<KinApprovalFailure | null>(null);
  const card = kinApprovalCardView(view, {
    decided: decided?.revision === action.revision ? decided.state : null,
    busy,
  });

  const openSetup = () =>
    navigation.navigate("KinApprovals", { environmentId, orgId: action.orgId });

  const decide = async (which: KinApprovalBusy) => {
    if (busy !== null || !card.decidable) return;
    setBusy(which);
    setFailure(null);
    const outcome =
      which === "approving"
        ? key._tag === "active"
          ? await approve({ environmentId, action, thumbprint: key.key.thumbprint })
          : null
        : await reject({ environmentId, action });
    setBusy(null);
    if (outcome === null || outcome._tag === "canceled") return;
    if (outcome._tag === "done") {
      setDecided({ revision: action.revision, state: outcome.state });
      refresh();
      return;
    }
    setFailure(outcome.failure);
    if (outcome.failure.refresh) refresh();
  };

  const showButtons = card.decidable && canDecide;
  const approveReady = key._tag === "active";
  return (
    <CardBody card={card}>
      {failure === null ? null : (
        <Text
          textRole="footnote"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-t3-medium text-danger-foreground"
        >
          {failure.text}
        </Text>
      )}
      {card.decidable && !canDecide ? (
        <Text textRole="footnote" className="text-foreground-muted">
          This device can't approve. Pair it again from the Mac.
        </Text>
      ) : null}
      {showButtons && !approveReady && key._tag !== "loading" ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {key._tag === "pending"
            ? "Finish setting up approvals on this phone to approve."
            : key._tag === "unattested"
              ? "This phone can't approve: it couldn't prove its key is in secure hardware."
              : "Set up approvals on this phone to approve with Face ID."}
        </Text>
      ) : null}
      {showButtons && approveReady && card.approveBlocked !== null ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {card.approveBlocked}
        </Text>
      ) : null}
      {showButtons || busy !== null ? (
        <View className="flex-row flex-wrap gap-2 pt-1">
          {approveReady || key._tag === "loading" ? (
            <Button
              label="Approve"
              tone="primary"
              loading={busy === "approving"}
              disabled={
                busy !== null || !approveReady || card.approveBlocked !== null || !card.decidable
              }
              onPress={() => void decide("approving")}
            />
          ) : key._tag !== "unattested" ? (
            <Button
              label={key._tag === "pending" ? "Finish setup" : "Set up approvals"}
              tone="primary"
              disabled={busy !== null}
              onPress={openSetup}
            />
          ) : null}
          <Button
            label="Decline"
            tone="secondary"
            loading={busy === "declining"}
            disabled={busy !== null || !card.decidable}
            onPress={() => void decide("declining")}
          />
        </View>
      ) : null}
      {failure?.reenrol === true ? (
        <View className="flex-row pt-1">
          <Button tone="secondary" size="compact" label="Set up approvals" onPress={openSetup} />
        </View>
      ) : null}
    </CardBody>
  );
}

function Frame(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View
      accessibilityLabel={props.label}
      className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4"
    >
      {props.children}
    </View>
  );
}

function CardBody(props: { readonly card: KinApprovalCardView; readonly children?: ReactNode }) {
  const { card } = props;
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <View accessible accessibilityLabel={card.accessibilityLabel} className="gap-1.5">
        <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
          {card.eyebrow}
        </Text>
        <Text textRole="headline" className="font-t3-bold text-foreground">
          {card.title}
        </Text>
        {card.subtitle === null ? null : (
          <Text textRole="footnote" numberOfLines={2} className="text-foreground-secondary">
            {card.subtitle}
          </Text>
        )}
      </View>
      {card.facts.length === 0 ? null : (
        <View className="gap-1.5">
          {card.facts.map((fact) => (
            <View key={fact.key} className="flex-row gap-3">
              <Text textRole="caption" className="w-24 text-foreground-muted">
                {fact.label}
              </Text>
              <Text
                textRole="footnote"
                selectable={fact.selectable}
                className={cn("min-w-0 flex-1 text-foreground", fact.selectable && "font-mono")}
              >
                {fact.value}
              </Text>
            </View>
          ))}
          {card.checks.map((check) => (
            <View key={check.key} className="flex-row gap-3">
              <View className="w-24" />
              <Text textRole="caption" className={cn("min-w-0 flex-1", CHECK_TONE[check.status])}>
                {`${check.name}: ${check.label}`}
              </Text>
            </View>
          ))}
        </View>
      )}
      {card.asked === null ? null : (
        <Text
          textRole="footnote"
          className={card.asked.warning ? "text-warning-foreground" : "text-foreground-secondary"}
        >
          {card.asked.text}
        </Text>
      )}
      {card.reason === null ? null : (
        <View className="gap-0.5">
          <Text textRole="caption" className="text-foreground-muted">
            {card.reason.label}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted">
            {`“${card.reason.text}”`}
          </Text>
        </View>
      )}
      {card.status === null ? null : (
        <Text
          textRole="footnote"
          accessibilityLiveRegion="polite"
          className="font-t3-medium text-foreground"
        >
          {card.status}
        </Text>
      )}
      {props.children}
    </View>
  );
}
