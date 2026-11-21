import { useLocation } from "@tanstack/react-router";

import { KinMemoryView } from "../KinMemoryView";
import { kinSettingsFindIn } from "../kinSettingsAddress";
import type { KinSettingsTarget } from "./kinSettingsTarget";

/** Memory, filtered to what a search result named. */
export function KinMemoryPage(props: KinSettingsTarget) {
  const find = useLocation({ select: (location) => kinSettingsFindIn(location.searchStr) });
  return <KinMemoryView key={`${props.orgId}\u0000${find}`} {...props} find={find} />;
}
