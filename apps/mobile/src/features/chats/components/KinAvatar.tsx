import { Blobatar } from "@blobatar/react-native";
import type { KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";
import { View } from "react-native";

import { cn } from "../../../lib/cn";

/** Online: the chat is live. Working: the lead is on a run. Both static; nothing animates here. */
export type KinAvatarStatus = "online" | "working";

/**
 * The frame says what it is (DESIGN 8.7): an agent is an outlined rounded square, a person a
 * filled circle, a group a filled rounded square. The blobatar inside says which one.
 */
export function KinAvatar(props: {
  readonly avatar: KinAvatarView;
  /** `small` sits in the chat's header pill and status row. */
  readonly size?: "regular" | "small";
  readonly status?: KinAvatarStatus | null;
}) {
  const { kind, seed } = props.avatar;
  const small = props.size === "small";
  const square = small ? "rounded-[9px]" : "rounded-[12px]";
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      className={small ? "size-7" : "size-10"}
    >
      <View
        className={cn(
          "size-full items-center justify-center overflow-hidden",
          kind === "agent" && cn(square, "border-[1.5px] border-primary"),
          kind === "person" && "rounded-full border border-secondary-border bg-secondary",
          kind === "group" && cn(square, "border border-secondary-border bg-secondary"),
        )}
      >
        <Blobatar name={seed} size={small ? 24 : 36} />
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
