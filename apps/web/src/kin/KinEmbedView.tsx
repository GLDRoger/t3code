import { kinChartView } from "@t3tools/client-runtime/kin/kinChart";
import type { EnvironmentId, KinEmbed, KinOrgId } from "@t3tools/contracts";

import { CardFrame } from "./KinCards";
import { KinChart } from "./KinChart";
import { KinVisual } from "./KinVisual";

/** A figure the host drew for a block of a doc or a message, at its column's width. */
export function KinEmbedView(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly embed: KinEmbed;
}) {
  const { embed } = props;
  switch (embed._tag) {
    case "chart":
      return (
        <CardFrame>
          <KinChart view={kinChartView(embed.chart)} />
        </CardFrame>
      );
    case "visual":
      return (
        <CardFrame label={embed.title}>
          <KinVisual environmentId={props.environmentId} orgId={props.orgId} visual={embed} />
        </CardFrame>
      );
    case "broken":
      return <p className="text-sm text-muted-foreground">{embed.message}</p>;
  }
}
