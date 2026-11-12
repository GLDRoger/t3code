import { useAtomValue } from "@effect/atom-react";
import {
  kinInboxAttention,
  kinSwitcherDot,
  kinSwitcherLabel,
  NO_KIN_LIST_ATTENTION,
} from "@t3tools/client-runtime/kin/kinListSwitch";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { kinClient } from "../state/kinClient";
import { useKinHost } from "../state/useKinHost";

const noInboxAtom = Atom.make(null);

/**
 * The brand mark as the switch from coding threads to Kin chats (VISION, Surfaces). `children`
 * gets the mark's trailing glyph and dot to draw inside the brand, so they count toward its
 * width. Without a Kin host the brand is drawn as it always was.
 */
export function KinListSwitch(props: {
  readonly onOpenKin: () => void;
  readonly children: (trailing: ReactNode) => ReactNode;
}) {
  const host = useKinHost();
  const hosted = host._tag === "host";
  const inbox = useAtomValue(
    hosted ? kinClient.inbox({ environmentId: host.environmentId, input: {} }) : noInboxAtom,
  );
  if (!hosted) return props.children(null);
  const dot = kinSwitcherDot({
    current: "threads",
    kin: kinInboxAttention(inbox?._tag === "Success" ? inbox.value.value : null),
    threads: NO_KIN_LIST_ATTENTION,
  });
  const label = kinSwitcherLabel({ current: "threads", dot });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label.accessibilityLabel}
      hitSlop={10}
      onPress={props.onOpenKin}
      className="flex-row items-center active:opacity-60"
    >
      {props.children(
        <View className="flex-row items-center gap-1.5 pl-1">
          <SymbolView
            name="arrow.left.arrow.right"
            size={13}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
            weight="semibold"
          />
          {dot === null ? null : <View className="size-2 rounded-full bg-primary" />}
        </View>,
      )}
    </Pressable>
  );
}
