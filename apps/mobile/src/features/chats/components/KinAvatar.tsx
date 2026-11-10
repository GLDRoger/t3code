import { Blobatar } from "@blobatar/react-native";
import type { KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";
import { View } from "react-native";

const SIZE = { small: 28, regular: 40, large: 48 } as const;

/** Who a chat is with: the blobatar for their stable id, with nothing drawn around it. */
export function KinAvatar(props: {
  readonly avatar: KinAvatarView;
  /** `small` sits beside a chat's title and status line; `large` heads a lead's details. */
  readonly size?: "regular" | "small" | "large";
}) {
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants">
      <Blobatar name={props.avatar.seed} size={SIZE[props.size ?? "regular"]} />
    </View>
  );
}
