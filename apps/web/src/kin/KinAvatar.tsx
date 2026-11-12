import { Blobatar } from "@blobatar/react";
import type { KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";

/** Who a chat is with: the blobatar for their stable id, with nothing drawn around it. */
export function KinAvatar(props: {
  readonly avatar: KinAvatarView;
  /** `sm` sits in a header beside the chat's title; `xs` leads an author line. */
  readonly size?: "md" | "sm" | "xs";
}) {
  return (
    <span aria-hidden className="flex shrink-0">
      <Blobatar
        name={props.avatar.seed}
        size={props.size === "xs" ? 16 : props.size === "sm" ? 24 : 32}
        alt=""
        draggable={false}
      />
    </span>
  );
}
