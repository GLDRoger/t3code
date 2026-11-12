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
  kinListSwitchHref,
  noAttentionAtom,
  threadsAttentionAtom,
} from "./kinListSwitch";
import { useKinHost } from "./useKinHost";

export interface KinListSwitch {
  readonly current: KinList;
  readonly dot: KinSwitcherDot;
  readonly title: string;
  readonly accessibilityLabel: string;
  readonly switchList: () => void;
}

/** The brand mark's switch between coding threads and Kin; null while no host runs Kin. */
export function useKinListSwitch(): KinListSwitch | null {
  const host = useKinHost();
  const navigate = useNavigate();
  const current = useLocation({ select: (location) => kinListShownAt(location.pathname) });
  const hosted = host._tag === "host";
  // Each side is read only while it is the other list, so the dot costs nothing it doesn't show.
  const kin = useAtomValue(
    hosted && current === "threads" ? kinInboxAttentionAtom(host.environmentId) : noAttentionAtom,
  );
  const threads = useAtomValue(
    hosted && current === "kin" ? threadsAttentionAtom : noAttentionAtom,
  );
  if (!hosted) return null;
  const dot = kinSwitcherDot({ current, kin, threads });
  return {
    current,
    dot,
    ...kinSwitcherLabel({ current, dot }),
    switchList: () => void navigate({ href: kinListSwitchHref(current) }),
  };
}
