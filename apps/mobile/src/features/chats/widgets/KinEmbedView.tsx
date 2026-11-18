import { kinChartView } from "@t3tools/client-runtime/kin/kinChart";
import type { EnvironmentId, KinEmbed, KinOrgId } from "@t3tools/contracts";

import { AppText as Text } from "../../../components/ui/AppText";
import { KinVisual } from "./KinVisual";
import { KinChartCard } from "./KinWidgetView";

/** A figure the host drew for a block of a doc or a message, at its column's width. */
export function KinEmbedView(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly embed: KinEmbed;
}) {
  const { embed } = props;
  switch (embed._tag) {
    case "chart":
      return <KinChartCard view={kinChartView(embed.chart)} />;
    case "visual":
      return <KinVisual environmentId={props.environmentId} orgId={props.orgId} visual={embed} />;
    case "broken":
      return (
        <Text textRole="footnote" className="text-foreground-muted">
          {embed.message}
        </Text>
      );
  }
}
