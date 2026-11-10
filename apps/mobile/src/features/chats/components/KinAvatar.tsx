import { Blobatar } from "@blobatar/react-native";
import type { KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";
import { View } from "react-native";

const SIZE = { mini: 18, small: 28, regular: 40, large: 48 } as const;

/** Who a chat is with: the blobatar for their stable id, with nothing drawn around it. */
export function KinAvatar(props: {
  readonly avatar: KinAvatarView;
  /** `mini` leads an author line; `small` sits beside a title; `large` heads a details sheet. */
  readonly size?: "regular" | "mini" | "small" | "large";
}) {
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants">
      <Blobatar name={props.avatar.seed} size={SIZE[props.size ?? "regular"]} />
    </View>
  );
}
