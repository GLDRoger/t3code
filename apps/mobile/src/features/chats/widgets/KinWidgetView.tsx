import { useAtomValue } from "@effect/atom-react";
import type { KinChartView } from "@t3tools/client-runtime/kin/kinChart";
import { kinAccessAtom } from "@t3tools/client-runtime/kin/kinAccess";
import {
  kinOwnerLevel,
  type EnvironmentId,
  type KinPersonId,
  type KinWidget,
} from "@t3tools/contracts";
import { memo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { environmentCatalog } from "../../../connection/catalog";
import { connectionAtomRuntime } from "../../../connection/runtime";
import { serverEnvironment } from "../../../state/server";
import { kinListedModelName } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import {
  KIN_MISSING_CARD_TEXT,
  kinCardView,
} from "@t3tools/client-runtime/kin/kinCardPresentation";
import { KinApprovalCard } from "./KinApprovalCard";
import { KinChart } from "./KinChart";
import { KinChoiceCard } from "./KinChoiceCard";
import { KinDeferralCard } from "./KinDeferralCard";
import { KinDigestCard } from "./KinDigestCard";
import { KinDocCard } from "./KinDocCard";
import { KinHostTroubleCard } from "./KinHostTroubleCard";
import { KinMemoryChangesCard } from "./KinMemoryChangesCard";
import { KinSocialPackCard, KinSocialWeekCard } from "./KinSocialCards";
import { KinStatementPasswordCard, KinStatementReviewCard } from "./KinStatementCards";
import { KinTaskCard } from "./KinTaskCard";
import { KinVisual } from "./KinVisual";

/** A model id as Settings names it on this environment, or null where it has no name. */
export function useKinModelName(environmentId: EnvironmentId) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  return (model: string) => kinListedModelName(model, providers);
}

/** A chart in a card's frame, in a chat or a doc alike. */
export function KinChartCard(props: { readonly view: KinChartView }) {
  return (
    <View className="rounded-[20px] border border-border bg-card-alt p-4">
      <KinChart view={props.view} />
    </View>
  );
}

/** The native card for a message's widget. Only a `visual` card draws a page, in a sealed view. */
export const KinWidgetView = memo(function KinWidgetView(props: {
  readonly widget: KinWidget | undefined;
  /** The environment hosting the chat. */
  readonly environmentId: EnvironmentId;
  readonly viewerPersonId: KinPersonId | null;
  readonly onOpenLink: (url: string) => void;
  /** The card's agent by name when it is retired, so its reminders and schedules read as on hold. */
  readonly heldFor?: string | null;
  /** The viewer may only read this chat: a draft's card offers no Send to. */
  readonly readOnly?: boolean;
  /** The chat's agents by id, for the doc card's "by Growth". */
  readonly agentNames?: ReadonlyMap<string, string>;
  /** The message's own long press, for a card that takes presses across its whole face. */
  readonly onLongPress?: () => void;
}) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const access = useAtomValue(kinAccessAtom(connectionAtomRuntime, props.environmentId));
  const modelName = useKinModelName(props.environmentId);
  // Before the catalog loads, assume the environment is known; the thread screen handles the rest.
  const view = kinCardView(
    props.widget,
    props.environmentId,
    (environmentId) => !catalog.isReady || catalog.entries.has(environmentId),
    props.heldFor ?? null,
    access === null ? undefined : kinOwnerLevel(access),
    modelName,
  );
  switch (view.kind) {
    case "task":
      return <KinTaskCard task={view.task} onOpenLink={props.onOpenLink} />;
    case "deferral":
      return <KinDeferralCard deferral={view.deferral} environmentId={props.environmentId} />;
    case "choice":
      return (
        <KinChoiceCard
          choice={view.choice}
          environmentId={props.environmentId}
          viewerPersonId={props.viewerPersonId}
        />
      );
    case "chart":
      return <KinChartCard view={view.chart} />;
    case "visual":
      return (
        <KinVisual environmentId={props.environmentId} orgId={view.orgId} visual={view.visual} />
      );
    case "digest":
      return <KinDigestCard digest={view.digest} onOpenLink={props.onOpenLink} />;
    case "memory_changes":
      return <KinMemoryChangesCard changes={view.changes} environmentId={props.environmentId} />;
    case "approval":
      return (
        <KinApprovalCard
          environmentId={props.environmentId}
          actionId={view.approval.actionId}
          revision={view.approval.revision}
        />
      );
    case "doc":
      return props.widget === undefined ? null : (
        <KinDocCard
          doc={view.doc}
          environmentId={props.environmentId}
          orgId={props.widget.orgId}
          ownerLevel={access === null || kinOwnerLevel(access)}
          readOnly={props.readOnly === true}
          {...(props.agentNames === undefined ? {} : { agentNames: props.agentNames })}
          {...(props.onLongPress === undefined ? {} : { onLongPress: props.onLongPress })}
        />
      );
    case "statement_review":
      return <KinStatementReviewCard review={view.review} environmentId={props.environmentId} />;
    case "statement_password":
      return (
        <KinStatementPasswordCard password={view.password} environmentId={props.environmentId} />
      );
    case "social_week":
      return <KinSocialWeekCard week={view.week} environmentId={props.environmentId} />;
    case "social_pack":
      return <KinSocialPackCard pack={view.pack} environmentId={props.environmentId} />;
    case "host_trouble":
      return <KinHostTroubleCard widget={view.widget} environmentId={props.environmentId} />;
    case "missing":
      return (
        <View className="rounded-[20px] border border-border bg-card-alt px-4 py-3">
          <Text textRole="footnote" className="text-foreground-muted">
            {KIN_MISSING_CARD_TEXT}
          </Text>
        </View>
      );
    case "unknown":
      return view.text === null ? null : (
        <View className="rounded-[20px] border border-border bg-card-alt px-4 py-3">
          <Text textRole="footnote" className="text-foreground">
            {view.text}
          </Text>
        </View>
      );
  }
});
