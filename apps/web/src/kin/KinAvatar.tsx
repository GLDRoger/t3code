import { Blobatar } from "@blobatar/react";
import type { KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";

import { useKinPicture } from "./kinPictures";

const PIXELS = { lg: 72, md: 32, sm: 24, xs: 16 } as const;
/**
 * Who a chat is with: the picture they chose, else the blobatar for their stable id. An agent is
 * drawn the same way, from its own id.
 */
export function KinAvatar(props: {
  readonly avatar: KinAvatarView;
  /** `sm` sits in a header beside the chat's title; `xs` leads an author line; `lg` heads a profile. */
  readonly size?: "lg" | "md" | "sm" | "xs";
}) {
  const size = PIXELS[props.size ?? "md"];
  const picture = useKinPicture(props.avatar.seed);
  return (
    <span aria-hidden data-kin-avatar={props.avatar.kind} className="flex shrink-0">
      {picture === undefined ? (
        <Blobatar name={props.avatar.seed} size={size} alt="" draggable={false} />
      ) : (
        <img
          src={picture}
          alt=""
          width={size}
          height={size}
          draggable={false}
          className="rounded-full object-cover"
          style={{ width: size, height: size }}
        />
      )}
    </span>
  );
}
