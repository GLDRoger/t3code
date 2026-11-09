import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, KinPersonId, KinWidget } from "@t3tools/contracts";
import { memo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { environmentCatalog } from "../../../connection/catalog";
import { KIN_MISSING_CARD_TEXT, KIN_UNKNOWN_CARD_TEXT, kinCardView } from "./kinCardPresentation";
import { KinChoiceCard } from "./KinChoiceCard";
import { KinDeferralCard } from "./KinDeferralCard";
import { KinDigestCard } from "./KinDigestCard";
import { KinMemoryChangesCard } from "./KinMemoryChangesCard";
import { KinPromotionCard } from "./KinPromotionCard";
import { KinShadowReviewCard } from "./KinShadowReviewCard";
import { KinTaskCard } from "./KinTaskCard";

/** The native card for a message's widget. Never falls back to HTML. */
export const KinWidgetView = memo(function KinWidgetView(props: {
  readonly widget: KinWidget | undefined;
  /** The environment hosting the chat. */
  readonly environmentId: EnvironmentId;
  readonly viewerPersonId: KinPersonId | null;
  readonly onOpenLink: (url: string) => void;
}) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  // Before the catalog loads, assume the environment is known; the thread screen handles the rest.
  const view = kinCardView(
    props.widget,
    props.environmentId,
    (environmentId) => !catalog.isReady || catalog.entries.has(environmentId),
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
    case "shadow_review":
      return <KinShadowReviewCard review={view.review} environmentId={props.environmentId} />;
    case "promotion":
      return <KinPromotionCard promotion={view.promotion} environmentId={props.environmentId} />;
    case "memory_changes":
      return <KinMemoryChangesCard changes={view.changes} environmentId={props.environmentId} />;
    case "missing":
    case "unknown":
      return (
        <View className="rounded-[20px] border border-border bg-card-alt px-4 py-3">
          <Text textRole="footnote" className="text-foreground-muted">
            {view.kind === "missing" ? KIN_MISSING_CARD_TEXT : KIN_UNKNOWN_CARD_TEXT}
          </Text>
        </View>
      );
  }
});
