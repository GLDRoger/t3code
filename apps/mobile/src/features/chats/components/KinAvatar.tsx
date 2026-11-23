import { Blobatar } from "@blobatar/react-native";
import { kinPersonSeed } from "@t3tools/client-runtime/kin/kinProfiles";
import type { KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";
import { Image } from "expo-image";
import { View } from "react-native";

import { useAssetUrl } from "../../../state/assets";
import { useKinHostProfiles } from "../state/useKinProfiles";

const SIZE = { mini: 18, small: 28, regular: 40, large: 48, profile: 88 } as const;

/**
 * Who a chat is with: the picture they chose, else the blobatar for their stable id. An agent is
 * drawn the same way, from its own id.
 */
export function KinAvatar(props: {
  readonly avatar: KinAvatarView;
  /** `mini` leads an author line; `small` sits beside a title; `large` heads a details sheet. */
  readonly size?: keyof typeof SIZE;
}) {
  const size = SIZE[props.size ?? "regular"];
  const { environmentId, profiles } = useKinHostProfiles();
  const pictureId =
    props.avatar.kind === "person"
      ? (profiles.find((profile) => kinPersonSeed(profile.personId) === props.avatar.seed)
          ?.pictureId ?? null)
      : null;
  const url = useAssetUrl(
    pictureId === null ? null : environmentId,
    pictureId === null
      ? null
      : { _tag: "attachment", attachmentId: pictureId, fileName: "picture" },
  );
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants">
      {url === null ? (
        <Blobatar name={props.avatar.seed} size={size} />
      ) : (
        <Image
          source={{ uri: url }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
      )}
    </View>
  );
}
