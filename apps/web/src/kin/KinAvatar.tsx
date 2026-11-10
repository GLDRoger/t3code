import { Blobatar } from "@blobatar/react";
import type { KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";

import { cn } from "../lib/utils";

/**
 * The frame says what it is (DESIGN 8.7): an agent is an outlined square, a person a filled
 * circle, a group a filled square. The blobatar inside says which one. Static, so nothing repaints.
 */
export function KinAvatar(props: { readonly avatar: KinAvatarView }) {
  const { kind, seed } = props.avatar;
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-9 shrink-0 items-center justify-center",
        kind === "agent" && "rounded-lg border-2 border-primary",
        kind === "person" && "rounded-full border bg-secondary",
        kind === "group" && "rounded-lg border bg-secondary",
      )}
    >
      <Blobatar name={seed} size={26} alt="" draggable={false} />
    </span>
  );
}
