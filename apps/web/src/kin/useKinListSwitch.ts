import { useAtomValue } from "@effect/atom-react";
import {
  kinSwitcherDot,
  kinSwitcherLabel,
  type KinList,
  type KinSwitcherDot,
} from "@t3tools/client-runtime/kin/kinListSwitch";
import { useLocation, useNavigate } from "@tanstack/react-router";

import {
  kinInboxAttentionAtom,
  kinListShownAt,
  kinReturnHref,
  noAttentionAtom,
} from "./kinListSwitch";
import { useKinHost } from "./useKinHost";

export interface KinListSwitch {
  readonly current: KinList;
  readonly dot: KinSwitcherDot;
  readonly title: string;
  readonly accessibilityLabel: string;
  readonly switchList: () => void;
}

/** The way from coding threads into Kin (palette and shortcut); null while no host runs Kin. */
export function useKinListSwitch(): KinListSwitch | null {
  const host = useKinHost();
  const navigate = useNavigate();
  const current = useLocation({ select: (location) => kinListShownAt(location.pathname) });
  const hosted = host._tag === "host";
  // Read only over the threads, so the dot costs nothing it doesn't show.
  const kin = useAtomValue(
    hosted && current === "threads" ? kinInboxAttentionAtom(host.environmentId) : noAttentionAtom,
  );
  if (!hosted) return null;
  const dot = kinSwitcherDot(kin);
  return {
    current,
    dot,
    ...kinSwitcherLabel(dot),
    switchList: () => void navigate({ href: kinReturnHref() }),
  };
}
