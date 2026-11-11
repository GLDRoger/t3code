import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, KinPersonId, KinWidget } from "@t3tools/contracts";
import { memo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { environmentCatalog } from "../../../connection/catalog";
import {
  KIN_MISSING_CARD_TEXT,
  kinCardView,
} from "@t3tools/client-runtime/kin/kinCardPresentation";
import { KinApprovalCard } from "./KinApprovalCard";
import { KinChoiceCard } from "./KinChoiceCard";
import { KinDeferralCard } from "./KinDeferralCard";
import { KinDigestCard } from "./KinDigestCard";
import { KinMemoryChangesCard } from "./KinMemoryChangesCard";
import { KinTaskCard } from "./KinTaskCard";

/** The native card for a message's widget. Never falls back to HTML. */
export const KinWidgetView = memo(function KinWidgetView(props: {
  readonly widget: KinWidget | undefined;
  /** The environment hosting the chat. */
  readonly environmentId: EnvironmentId;
  readonly viewerPersonId: KinPersonId | null;
  readonly onOpenLink: (url: string) => void;
  /** The card's agent by name when it is retired, so its reminders and schedules read as on hold. */
  readonly heldFor?: string | null;
}) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  // Before the catalog loads, assume the environment is known; the thread screen handles the rest.
  const view = kinCardView(
    props.widget,
    props.environmentId,
    (environmentId) => !catalog.isReady || catalog.entries.has(environmentId),
    props.heldFor ?? null,
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
