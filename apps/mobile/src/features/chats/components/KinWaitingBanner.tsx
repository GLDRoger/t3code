import type { KinWaitingBannerView } from "@t3tools/client-runtime/kin/kinScreenState";

import { KinListBanner } from "./KinListBanner";

/** What waits on the viewer, as the list's first row. Not rendered when nothing waits. */
export function KinWaitingBanner(props: {
  readonly view: KinWaitingBannerView;
  readonly onPress: () => void;
}) {
  return (
    <KinListBanner
      title="Waiting on you"
      summary={props.view.summary}
      symbol="exclamationmark.shield"
      tone="warning"
      accessibilityLabel={props.view.accessibilityLabel}
      accessibilityHint="Opens Waiting on you"
      onPress={props.onPress}
    />
  );
}
