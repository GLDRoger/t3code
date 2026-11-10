import { Blobatar } from "@blobatar/react-native";
import type { KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";
import { View } from "react-native";

import { cn } from "../../../lib/cn";

/** Online: the chat is live. Working: the lead is on a run. Both static; nothing animates here. */
export type KinAvatarStatus = "online" | "working";

const FRAME = { small: "size-7", regular: "size-10", large: "size-12" } as const;
const SQUARE = {
  small: "rounded-[9px]",
  regular: "rounded-[12px]",
  large: "rounded-[14px]",
} as const;
const BLOB = { small: 24, regular: 36, large: 44 } as const;

/**
 * The frame says what it is (DESIGN 8.7): an agent is an outlined rounded square, a person a
 * filled circle, a group a filled rounded square. The blobatar inside says which one.
 */
export function KinAvatar(props: {
  readonly avatar: KinAvatarView;
  /** `small` sits in the chat's header pill and status row; `large` leads a chat list row. */
  readonly size?: "regular" | "small" | "large";
  readonly status?: KinAvatarStatus | null;
}) {
  const { kind, seed } = props.avatar;
  const size = props.size ?? "regular";
  const square = SQUARE[size];
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      className={FRAME[size]}
    >
      <View
        className={cn(
          "size-full items-center justify-center overflow-hidden",
          kind === "agent" && cn(square, "border-[1.5px] border-primary"),
          kind === "person" && "rounded-full border border-secondary-border bg-secondary",
          kind === "group" && cn(square, "border border-secondary-border bg-secondary"),
        )}
      >
        <Blobatar name={seed} size={BLOB[size]} />
      </View>
      {props.status == null ? null : (
        <View
          className={cn(
            "absolute -right-1 -bottom-1 size-3 rounded-full border-2 border-screen",
            props.status === "working" ? "bg-primary" : "bg-adaptive-emerald-600-400",
          )}
        />
      )}
    </View>
  );
}
