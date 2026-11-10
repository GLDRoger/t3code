import { Blobatar } from "@blobatar/react-native";
import type { KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";
import { View } from "react-native";

import { cn } from "../../../lib/cn";

/**
 * The frame says what it is (DESIGN 8.7): an agent is an outlined rounded square, a person a
 * filled circle, a group a filled rounded square. The blobatar inside says which one.
 */
export function KinAvatar(props: { readonly avatar: KinAvatarView }) {
  const { kind, seed } = props.avatar;
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      className={cn(
        "size-10 items-center justify-center overflow-hidden",
        kind === "agent" && "rounded-[12px] border-[1.5px] border-primary",
        kind === "person" && "rounded-full border border-secondary-border bg-secondary",
        kind === "group" && "rounded-[12px] border border-secondary-border bg-secondary",
      )}
    >
      <Blobatar name={seed} size={36} />
    </View>
  );
}
